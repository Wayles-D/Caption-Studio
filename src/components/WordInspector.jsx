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
  onSelectionChange,
  setWordStyleKeyframe,
  getWordStyleKeyframeTimes,
  clearWordStyleKeyframes
} from '../js/components/canvasTransform.js';
import { breakWordOutOfCaption, canBreakWordOutOfCaption } from '../js/components/captionEvents.js';
import { wordToOverlay } from '../js/components/textElements.js';
import { isTranscriptWordHidden, setTranscriptWordHidden } from '../js/components/transcriptEditorState.js';
import { listFontOptions } from '../../shared/fontRegistry.js';
import { ColorPickerField } from './ColorPickerField.jsx';
import { ToggleSwitch } from './ToggleSwitch.jsx';
import { HoverSelect } from './HoverSelect.jsx';
import { previewWordStyle } from '../js/hoverPreview.js';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]';
const HINT = 'text-[12px] text-[var(--text-muted)] m-0';
const ACTION_BTN = 'h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--border-color)] bg-transparent text-[12px] font-bold text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--bg-card-hover)]';

/**
 * Switches a transcript word off the video (or back on). The same flag the
 * Transcript panel's ◉ sets — re-keyed on the saved value, because it can
 * change from either place or from an Undo, and an uncontrolled switch would
 * otherwise keep showing what it last showed.
 */
function WordHiddenToggle({ wordIndex, text }) {
  const hidden = isTranscriptWordHidden(wordIndex);
  return (
    <div className="flex items-center justify-between gap-3" id="word-hidden-row">
      <span className="text-xs font-semibold text-[var(--text-primary)]">
        {hidden ? <>“{text}” is hidden from the video</> : <>Hide “{text}” from the video</>}
      </span>
      <ToggleSwitch
        key={hidden ? 'hidden' : 'shown'}
        id="word-hidden-toggle"
        defaultChecked={hidden}
        title={hidden ? 'Show this word again' : 'Hide this word — every other word keeps its timing'}
        onChange={(e) => setTranscriptWordHidden(wordIndex, e.target.checked)}
      />
    </div>
  );
}
const GROUP_LABEL = 'text-[12px] font-medium text-[var(--text-secondary)]';
const SELECT = `h-8 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)]
  text-[12px] px-2 outline-none cursor-pointer transition-colors duration-200 hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
const SLIDER = `appearance-none w-full h-1.5 rounded-[3px] bg-[var(--border-color-hover)] outline-none cursor-pointer
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
  [&::-webkit-slider-thumb]:bg-[var(--accent-color)] [&::-webkit-slider-thumb]:cursor-pointer`;
const VALUE_BADGE = 'text-[11px] font-semibold text-[var(--text-secondary)] w-10 text-right shrink-0';
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
/**
 * A word's own case — shared with the Transcript panel's per-word control
 * (src/js/components/transcriptEditorState.js), so the two always offer the
 * same choices. 'none' is AS TYPED: the word exactly as written ("BHYND",
 * "iPhone"), even when it is a keyword whose style would re-case it.
 */
export const WORD_CASE_OPTIONS = [
  { value: 'none', label: 'As typed' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase', label: 'lowercase' },
  { value: 'capitalize', label: 'Capitalized' }
];

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
/**
 * KEYFRAMING ONE WORD'S FONT — "from here on, this word looks like that".
 *
 * A font cannot be interpolated, so these keyframes HOLD: the font set at
 * one stays until the next and then changes outright. The first one also
 * pins the font the word appeared with, so the change happens where the
 * playhead is rather than reaching back over the whole caption.
 */
function WordStyleKeyframeRow({ wordIndex, property, label, value }) {
  const times = getWordStyleKeyframeTimes(wordIndex, property);
  const on = times.length > 0;
  return (
    <div className="flex items-center gap-2 flex-wrap" id={`word-${property}-kf`}>
      <button
        type="button" id={`word-${property}-kf-add`}
        className={`h-6 px-2 rounded-[3px] border text-[11px] font-bold cursor-pointer ${on ? 'border-[var(--accent-color)] text-[var(--accent-color)]' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}
        title={`Change this word's ${label} from the playhead onwards`}
        onClick={() => setWordStyleKeyframe(wordIndex, property, value ?? null)}
      >◆ Change {label} here</button>
      {on && (
        <>
          <span className="text-[11px] text-[var(--text-muted)]" id={`word-${property}-kf-times`}>
            {times.map((t) => `${t.toFixed(2)}s`).join(', ')}
          </span>
          <button
            type="button" id={`word-${property}-kf-clear`}
            className="h-6 px-2 rounded-[3px] border border-[var(--border-color)] text-[11px] text-[var(--text-muted)] cursor-pointer"
            onClick={() => clearWordStyleKeyframes(wordIndex, property)}
          >Clear</button>
        </>
      )}
    </div>
  );
}

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
            className="text-[11px] font-semibold text-[var(--text-muted)] bg-transparent border-0 cursor-pointer p-0 hover:text-[var(--accent-color)]"
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

/**
 * The Word tool's own panel. A word of a text element is already edited in
 * the Text & Cinematic panel (TextInspector embeds this same inspector for
 * it), so while that panel is open the tool points there rather than showing
 * a second, identical set of controls beside it.
 */
export function WordToolPanel({ textPanelOpen = false }) {
  const [, forceRender] = useState(0);
  useEffect(() => onSelectionChange(() => forceRender((n) => n + 1)), []);
  const target = getSelectedWordStyleTarget();
  if (textPanelOpen && target?.textElementId) {
    return (
      <div className={CARD} id="word-tool-in-text-panel">
        <span className={SECTION_TITLE}>Editing in Text &amp; Cinematic</span>
        <p className={HINT}>
          <b>{target.text || 'This word'}</b> is part of a text element, so its own style is in the
          Text &amp; Cinematic panel on the right.
        </p>
      </div>
    );
  }
  return <WordInspector />;
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

  const { wordIndex, text, isKeyword, style, textElementId } = target;
  const set = (fields) => applyWordStyleFields(wordIndex, fields);
  const hasAnyOverride = Object.values(style).some((v) => v != null);

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex items-center justify-between gap-2">
          <span className={SECTION_TITLE}>Word</span>
          {isKeyword && (
            <span className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--accent-color)]">Keyword</span>
          )}
        </div>
        <span className="text-[15px] font-bold text-[var(--text-primary)] truncate" title={text}>“{text}”</span>
        <p className={HINT}>
          {hasAnyOverride
            ? 'This word has its own style. Anything left untouched still follows the caption.'
            : 'Currently following the caption’s style. Change anything below to override it for this word only.'}
        </p>
      </div>

      {/* --- This word in its caption ---
          Only for TRANSCRIPT words: a word inside a text element has no
          caption to break out of, hide from, or lift out of. */}
      {!textElementId && (
        <div className={CARD} id="word-caption-card">
          <span className={SECTION_TITLE}>Caption</span>

          {canBreakWordOutOfCaption(wordIndex) && (
            <div className="flex flex-col gap-1.5" id="word-break-card">
              <p className={HINT}>
                Give <b>{text}</b> a caption of its own, so it is no longer shown with the rest
                of the phrase. Its timing stays exactly where it is.
              </p>
              <button type="button" id="word-break-out" className={ACTION_BTN} onClick={() => breakWordOutOfCaption(wordIndex)}>
                Break “{text}” out
              </button>
            </div>
          )}

          {/* BEHIND SOMEONE: the word lifted out as a text overlay that keeps
              the caption's look and timing — free to drag above a head, with
              the "Behind a subject" control on its own panel. One undo. */}
          <div className="flex flex-col gap-1.5">
            <p className={HINT}>
              To put <b>{text}</b> behind a person or object, lift it out as its own text — it keeps
              this caption’s look and timing, and you can drag it anywhere.
            </p>
            <button type="button" id="word-to-overlay" className={ACTION_BTN} onClick={() => wordToOverlay(wordIndex)}>
              Put “{text}” behind someone…
            </button>
          </div>

          {/* HIDE: off the video, still in the transcript, still in the
              caption's timing — every word around it keeps its moment. */}
          <WordHiddenToggle wordIndex={wordIndex} text={text} />
        </div>
      )}

      {/* --- Typeface --- */}
      <div className={CARD}>
        <span className={SECTION_TITLE}>Typeface</span>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="word-font-select" className={GROUP_LABEL}>Font</label>
          <HoverSelect
            id="word-font-select"
            className={SELECT}
            value={style.fontFamily || ''}
            options={[{ value: '', label: 'Same as caption' }, ...listFontOptions().map((f) => ({ value: f.value, label: f.label }))]}
            onChange={(v) => set({ fontFamily: v || null })}
            onPreview={(v) => previewWordStyle(wordIndex, { fontFamily: v || null })}
          />
          <WordStyleKeyframeRow wordIndex={wordIndex} property="fontFamily" label="font" value={style.fontFamily} />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="word-weight-select" className={GROUP_LABEL}>Weight</label>
          <HoverSelect
            id="word-weight-select"
            className={SELECT}
            value={style.fontWeight || ''}
            options={[{ value: '', label: 'Same as caption' }, ...WEIGHT_OPTIONS]}
            onChange={(v) => set({ fontWeight: v || null })}
            onPreview={(v) => previewWordStyle(wordIndex, { fontWeight: v || null })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="word-case-select" className={GROUP_LABEL}>Case</label>
          <HoverSelect
            id="word-case-select"
            className={SELECT}
            value={style.textCase || ''}
            options={[{ value: '', label: 'Same as caption' }, ...WORD_CASE_OPTIONS]}
            onChange={(v) => set({ textCase: v || null })}
            onPreview={(v) => previewWordStyle(wordIndex, { textCase: v || null })}
          />
        </div>

        {/* Italic/underline are plain on/off for this word — there is no
            "inherit" state to represent, since neither exists at caption level. */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`${TOGGLE_BTN_BASE} ${style.italic ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF} italic`}
            onClick={() => set({ italic: style.italic ? null : true })}
            id="word-italic"
            title="Italic"
          >I</button>
          <button
            type="button"
            className={`${TOGGLE_BTN_BASE} ${style.underline ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF} underline`}
            onClick={() => set({ underline: style.underline ? null : true })}
            id="word-underline"
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
                className="text-[11px] font-semibold text-[var(--text-muted)] bg-transparent border-0 cursor-pointer p-0 hover:text-[var(--accent-color)]"
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
                className="text-[11px] font-semibold text-[var(--text-muted)] bg-transparent border-0 cursor-pointer p-0 hover:text-[var(--accent-color)]"
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
