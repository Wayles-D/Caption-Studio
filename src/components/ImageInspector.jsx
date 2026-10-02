/**
 * The Image panel — adding pictures and editing the selected IMAGE LAYER
 * (shared/imageLayer.js): timing, stacking, resting transform, crop, corners,
 * border, shadow and its entrance (the shared motion presets and easings).
 *
 * Built from the same controls and classes as the Text & Cinematic panel
 * (TextInspector.jsx). Every control writes through
 * src/js/components/imageLayers.js; a slider previews live while it is
 * dragged and commits ONE undo step when it is let go.
 */
import { useEffect, useRef, useState } from 'react';
import { appState, subscribe } from '../js/state.js';
import * as imageLayers from '../js/components/imageLayers.js';
import { ANIMATION_TYPES, EASING_TYPES } from '../../shared/captionAnimation.js';
import { ColorPickerField } from './ColorPickerField.jsx';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const GROUP_LABEL = 'text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.04em]';
const INPUT = `h-9 w-full bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)]
  text-[var(--text-primary)] text-[13px] px-2.5 outline-none transition-colors duration-200
  hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
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

const PLACEMENT_OPTIONS = [
  { value: 'under-captions', label: 'Below captions' },
  { value: 'under-text', label: 'Above captions' },
  { value: 'over-text', label: 'Above all text' }
];
const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const round = (v, step) => Math.round(v / step) * step;

/**
 * A slider over one numeric field. Dragging previews with history off and
 * commits the whole drag as ONE undo step on release (the rewind-then-commit
 * the canvas gestures use); a keyboard nudge, with no drag in progress,
 * commits straight away.
 */
function Slider({ id, label, value, min, max, step = 1, unit = '', format, onLive, layerId }) {
  const startRef = useRef(null);
  const shown = format ? format(value) : `${Number(value.toFixed(step < 1 ? 2 : 0))}${unit}`;
  const commit = () => {
    if (!startRef.current) return;
    const start = startRef.current;
    startRef.current = null;
    const final = imageLayers.getImageLayer(layerId);
    if (!final) return;
    imageLayers.updateImageLayer(layerId, start, { recordHistory: false });
    imageLayers.updateImageLayer(layerId, final, { recordHistory: true });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className={GROUP_LABEL}>{label}</span>
      <div className="flex items-center gap-2">
        <input
          id={id} type="range" min={min} max={max} step={step} className={SLIDER}
          value={value}
          onPointerDown={() => { startRef.current = JSON.parse(JSON.stringify(imageLayers.getImageLayer(layerId))); }}
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
function Toggle({ id, label, on, onChange }) {
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
function ColorRow({ id, label, value, openField, setOpenField, apply }) {
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
function TimeField({ id, label, value, onCommit }) {
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

function ImageEditor({ layer }) {
  const [openField, setOpenField] = useState(null);
  const id = layer.id;
  const t = layer.transform;
  const { crop, appearance } = layer;
  const entrance = (layer.motions || []).find((m) => m.kind === 'entrance') || null;
  const transform = (fields, opts) => imageLayers.patchImageLayer(id, 'transform', fields, opts);
  const setCrop = (fields, opts) => imageLayers.patchImageLayer(id, 'crop', fields, opts);
  const setAppearance = (fields, opts) => imageLayers.patchImageLayer(id, 'appearance', fields, opts);
  const setBorder = (fields, opts) => imageLayers.patchImageLayer(id, 'border', fields, opts);
  const setShadow = (fields, opts) => imageLayers.patchImageLayer(id, 'shadow', fields, opts);
  const setEntrance = (fields, opts) => imageLayers.setImageLayerEntrance(id, fields, opts);
  const pct = (v) => `${Math.round(v)}%`;

  return (
    <>
      <div className={CARD} id="image-editor">
        <div className="flex items-center justify-between gap-2">
          <span className={SECTION_TITLE}>Image</span>
          <span className="text-[11px] text-[var(--text-muted)] truncate max-w-[60%]" title={layer.name}>{layer.name || 'Untitled'}</span>
        </div>
        <div className="flex gap-2">
          <TimeField id="img-start" label="Start" value={layer.start} onCommit={(v) => imageLayers.moveImageLayer(id, v)} />
          <TimeField id="img-end" label="End" value={layer.end} onCommit={(v) => imageLayers.trimImageLayer(id, 'end', v)} />
          <TimeField id="img-duration" label="Duration" value={layer.end - layer.start} onCommit={(v) => imageLayers.trimImageLayer(id, 'end', layer.start + v)} />
        </div>
        <div className="flex gap-2">
          <button type="button" id="img-duplicate" className={`${SECONDARY_BTN} flex-1`} onClick={() => imageLayers.duplicateImageLayer(id)}>Duplicate</button>
          <button type="button" id="img-delete" className={`${SECONDARY_BTN} flex-1`} onClick={() => imageLayers.removeImageLayer(id)}>Delete</button>
        </div>
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Layer</span>
        <select id="img-layer" className={SELECT} value={layer.layer} onChange={(e) => imageLayers.setImageLayerPlacement(id, e.target.value)}>
          {PLACEMENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div className="grid grid-cols-4 gap-2">
          <button type="button" id="img-to-back" className={SECONDARY_BTN} title="Behind every other image here" onClick={() => imageLayers.reorderImageLayer(id, 'back')}>Back</button>
          <button type="button" id="img-backward" className={SECONDARY_BTN} title="One step back" onClick={() => imageLayers.reorderImageLayer(id, 'backward')}>Back 1</button>
          <button type="button" id="img-forward" className={SECONDARY_BTN} title="One step forward" onClick={() => imageLayers.reorderImageLayer(id, 'forward')}>Fwd 1</button>
          <button type="button" id="img-to-front" className={SECONDARY_BTN} title="In front of every other image here" onClick={() => imageLayers.reorderImageLayer(id, 'front')}>Front</button>
        </div>
        <p className={HINT}>Order among images at the same layer. Drag it on the video to move it; use the corners to resize and the top handle to rotate.</p>
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Transform</span>
        <Slider id="img-x" layerId={id} label="Position X" value={t.x} min={0} max={100} step={0.5} format={pct} onLive={(v, o) => transform({ x: v }, o)} />
        <Slider id="img-y" layerId={id} label="Position Y" value={t.y} min={0} max={100} step={0.5} format={pct} onLive={(v, o) => transform({ y: v }, o)} />
        <Slider id="img-width" layerId={id} label="Size" value={t.width} min={5} max={150} step={1} format={pct} onLive={(v, o) => transform({ width: v }, o)} />
        <Slider id="img-scale" layerId={id} label="Scale" value={t.scale} min={0.1} max={5} step={0.05} format={(v) => `${v.toFixed(2)}x`} onLive={(v, o) => transform({ scale: v }, o)} />
        <Slider id="img-rotation" layerId={id} label="Rotation" value={t.rotation} min={-180} max={180} step={1} unit="°" onLive={(v, o) => transform({ rotation: v }, o)} />
        <Slider id="img-opacity" layerId={id} label="Opacity" value={t.opacity} min={0} max={100} step={1} unit="%" onLive={(v, o) => transform({ opacity: v }, o)} />
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Crop</span>
        {['left', 'top', 'right', 'bottom'].map((edge) => (
          <Slider key={edge} id={`img-crop-${edge}`} layerId={id} label={titleCase(edge)} value={round(crop[edge] * 100, 1)} min={0} max={45} step={1} unit="%"
            onLive={(v, o) => setCrop({ [edge]: v / 100 }, o)} />
        ))}
        <p className={HINT}>Cropping hides part of the picture; the file itself is never changed.</p>
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Corners</span>
        <Slider id="img-radius" layerId={id} label="Roundness" value={appearance.cornerRadius} min={0} max={50} step={1} unit="%" onLive={(v, o) => setAppearance({ cornerRadius: v }, o)} />
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Border</span>
        <Toggle id="img-border" label="Border" on={appearance.border.enabled} onChange={(on) => setBorder({ enabled: on })} />
        {appearance.border.enabled && (
          <>
            <Slider id="img-border-width" layerId={id} label="Width" value={appearance.border.width} min={0} max={30} step={1} unit="px" onLive={(v, o) => setBorder({ width: v }, o)} />
            <ColorRow id="img-border-color" label="Colour" value={appearance.border.color} openField={openField} setOpenField={setOpenField} apply={(hex, o) => setBorder({ color: hex }, o)} />
          </>
        )}
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Shadow</span>
        <Toggle id="img-shadow" label="Shadow" on={appearance.shadow.enabled} onChange={(on) => setShadow({ enabled: on })} />
        {appearance.shadow.enabled && (
          <>
            <Slider id="img-shadow-blur" layerId={id} label="Blur" value={appearance.shadow.blur} min={0} max={60} step={1} unit="px" onLive={(v, o) => setShadow({ blur: v }, o)} />
            <Slider id="img-shadow-x" layerId={id} label="Offset X" value={appearance.shadow.offsetX} min={-50} max={50} step={1} unit="px" onLive={(v, o) => setShadow({ offsetX: v }, o)} />
            <Slider id="img-shadow-y" layerId={id} label="Offset Y" value={appearance.shadow.offsetY} min={-50} max={50} step={1} unit="px" onLive={(v, o) => setShadow({ offsetY: v }, o)} />
            <Slider id="img-shadow-opacity" layerId={id} label="Opacity" value={appearance.shadow.opacity} min={0} max={100} step={1} unit="%" onLive={(v, o) => setShadow({ opacity: v }, o)} />
            <ColorRow id="img-shadow-color" label="Colour" value={appearance.shadow.color} openField={openField} setOpenField={setOpenField} apply={(hex, o) => setShadow({ color: hex }, o)} />
          </>
        )}
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Animation</span>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="img-entrance" className={GROUP_LABEL}>Entrance</label>
          <select id="img-entrance" className={SELECT} value={entrance?.preset || 'none'} onChange={(e) => setEntrance({ preset: e.target.value, duration: entrance?.duration ?? 0.4, easing: entrance?.easing ?? 'ease-out' })}>
            {ANIMATION_TYPES.map((type) => <option key={type} value={type}>{type === 'none' ? 'None' : titleCase(type)}</option>)}
          </select>
        </div>
        {entrance && (
          <>
            <Slider id="img-entrance-duration" layerId={id} label="Duration" value={entrance.duration} min={0.1} max={2} step={0.05} format={(v) => `${v.toFixed(2)}s`} onLive={(v, o) => setEntrance({ duration: v }, o)} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="img-entrance-easing" className={GROUP_LABEL}>Easing</label>
              <select id="img-entrance-easing" className={SELECT} value={entrance.easing} onChange={(e) => setEntrance({ easing: e.target.value })}>
                {EASING_TYPES.map((easing) => <option key={easing} value={easing}>{titleCase(easing)}</option>)}
              </select>
            </div>
          </>
        )}
        <p className={HINT}>Plays from the image's own start on the timeline.</p>
      </div>
    </>
  );
}

export function ImageInspector() {
  const [, force] = useState(0);
  useEffect(() => subscribe('*', () => force((n) => n + 1)), []);
  const layers = appState.imageLayers || [];
  const selected = layers.find((img) => img.id === appState.selectedImageLayerId) || null;

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Images</span>
          <span className="text-[11px] font-semibold text-[var(--accent-color)]">{layers.length}</span>
        </div>
        <p className={HINT}>Pictures placed over the video for a stretch of the timeline. PNG, JPEG or WebP.</p>
        <button type="button" id="img-add" className={PRIMARY_BTN} onClick={() => imageLayers.promptForImageFile()}>+ Image at playhead</button>
        {layers.length > 0 && (
          <div className="flex flex-col gap-1.5" id="img-list">
            {layers.map((img) => (
              <button
                key={img.id} type="button"
                className={`${ROW_BASE} ${img.id === selected?.id ? 'border-[var(--accent-color)]' : 'border-[var(--border-color)]'}`}
                onClick={() => imageLayers.selectImageLayer(img.id)}
              >
                <span className="text-[10px] font-bold text-[var(--text-muted)]">IMG</span>
                <span className="text-[12px] text-[var(--text-primary)] truncate flex-1">{img.name || 'Image'}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{img.start.toFixed(1)}s</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected
        ? <ImageEditor layer={selected} />
        : layers.length > 0 && (
          <div className={CARD}>
            <span className={SECTION_TITLE}>Nothing selected</span>
            <p className={HINT}>Pick one above, click it on the video, or click its clip on the Images lane.</p>
          </div>
        )}
    </div>
  );
}
