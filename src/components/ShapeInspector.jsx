/**
 * The Shape panel — adding shapes and editing the selected SHAPE LAYER
 * (shared/shapeLayer.js): kind, timing, its place in the one layer stack,
 * resting geometry, fill, border, corners, shadow, and its entrance (the
 * shared motion presets and easings). The same controls as the Image panel
 * (LayerInspectorControls.jsx), writing through
 * src/js/components/shapeLayers.js.
 */
import { useEffect, useState } from 'react';
import { appState, subscribe } from '../js/state.js';
import * as shapeLayers from '../js/components/shapeLayers.js';
import { SHAPE_KINDS, SHAPE_LABELS } from '../../shared/shapeLayer.js';
import { ANIMATION_TYPES, EASING_TYPES } from '../../shared/captionAnimation.js';
import { LayerOrderControls } from './LayerControls.jsx';
import { CARD, SECTION_TITLE, HINT, GROUP_LABEL, SELECT, SECONDARY_BTN, ROW_BASE, titleCase, Slider as SharedSlider, Toggle, ColorRow, TimeField } from './LayerInspectorControls.jsx';

const SHAPE_API = { get: shapeLayers.getShapeLayer, update: shapeLayers.updateShapeLayer };
const Slider = (props) => <SharedSlider api={SHAPE_API} {...props} />;

function ShapeEditor({ shape }) {
  const [openField, setOpenField] = useState(null);
  const id = shape.id;
  const t = shape.transform;
  const a = shape.appearance;
  const entrance = (shape.motions || []).find((m) => m.kind === 'entrance') || null;
  const transform = (fields, opts) => shapeLayers.patchShapeLayer(id, 'transform', fields, opts);
  const setAppearance = (fields, opts) => shapeLayers.patchShapeLayer(id, 'appearance', fields, opts);
  const setFill = (fields, opts) => shapeLayers.patchShapeLayer(id, 'fill', fields, opts);
  const setBorder = (fields, opts) => shapeLayers.patchShapeLayer(id, 'border', fields, opts);
  const setShadow = (fields, opts) => shapeLayers.patchShapeLayer(id, 'shadow', fields, opts);
  const setEntrance = (fields, opts) => shapeLayers.setShapeLayerEntrance(id, fields, opts);
  const pct = (v) => `${Math.round(v * 10) / 10}%`;
  const isLine = shape.kind === 'line' || shape.kind === 'arrow';

  return (
    <>
      <div className={CARD} id="shape-editor">
        <div className="flex items-center justify-between gap-2">
          <span className={SECTION_TITLE}>Shape</span>
          <select id="shape-kind" className={`${SELECT} w-auto`} value={shape.kind} onChange={(e) => shapeLayers.updateShapeLayer(id, { kind: e.target.value })}>
            {SHAPE_KINDS.map((k) => <option key={k} value={k}>{SHAPE_LABELS[k]}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <TimeField id="shape-start" label="Start" value={shape.start} onCommit={(v) => shapeLayers.moveShapeLayer(id, v)} />
          <TimeField id="shape-end" label="End" value={shape.end} onCommit={(v) => shapeLayers.trimShapeLayer(id, 'end', v)} />
          <TimeField id="shape-duration" label="Duration" value={shape.end - shape.start} onCommit={(v) => shapeLayers.trimShapeLayer(id, 'end', shape.start + v)} />
        </div>
        <div className="flex gap-2">
          <button type="button" id="shape-duplicate" className={`${SECONDARY_BTN} flex-1`} onClick={() => shapeLayers.duplicateShapeLayer(id)}>Duplicate</button>
          <button type="button" id="shape-delete" className={`${SECONDARY_BTN} flex-1`} onClick={() => shapeLayers.removeShapeLayer(id)}>Delete</button>
        </div>
      </div>

      <LayerOrderControls id={id} idPrefix="shape" />

      <div className={CARD}>
        <span className={SECTION_TITLE}>Size &amp; position</span>
        <Slider id="shape-x" layerId={id} label="Position X" value={t.x} min={0} max={100} step={0.5} format={pct} onLive={(v, o) => transform({ x: v }, o)} />
        <Slider id="shape-y" layerId={id} label="Position Y" value={t.y} min={0} max={100} step={0.5} format={pct} onLive={(v, o) => transform({ y: v }, o)} />
        <Slider id="shape-width" layerId={id} label={isLine ? 'Length' : 'Width'} value={t.width} min={1} max={150} step={0.5} format={pct} onLive={(v, o) => transform({ width: v }, o)} />
        <Slider id="shape-height" layerId={id} label={shape.kind === 'line' ? 'Thickness' : 'Height'} value={t.height} min={0.5} max={150} step={0.5} format={pct} onLive={(v, o) => transform({ height: v }, o)} />
        <Slider id="shape-scale" layerId={id} label="Scale" value={t.scale} min={0.1} max={5} step={0.05} format={(v) => `${v.toFixed(2)}x`} onLive={(v, o) => transform({ scale: v }, o)} />
        <Slider id="shape-rotation" layerId={id} label="Rotation" value={t.rotation} min={-180} max={180} step={1} unit="°" onLive={(v, o) => transform({ rotation: v }, o)} />
        <Slider id="shape-opacity" layerId={id} label="Opacity" value={t.opacity} min={0} max={100} step={1} unit="%" onLive={(v, o) => transform({ opacity: v }, o)} />
        <p className={HINT}>Drag it on the video to move it; the corners resize it and the top handle rotates it.</p>
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Fill</span>
        <Toggle id="shape-fill" label="Fill" on={a.fill.enabled} onChange={(on) => setFill({ enabled: on })} />
        {a.fill.enabled && (
          <ColorRow id="shape-fill-color" label="Colour" value={a.fill.color} openField={openField} setOpenField={setOpenField} apply={(hex, o) => setFill({ color: hex }, o)} />
        )}
      </div>

      {shape.kind === 'rounded' && (
        <div className={CARD}>
          <span className={SECTION_TITLE}>Corners</span>
          <Slider id="shape-radius" layerId={id} label="Roundness" value={a.cornerRadius} min={0} max={50} step={1} unit="%" onLive={(v, o) => setAppearance({ cornerRadius: v }, o)} />
        </div>
      )}

      <div className={CARD}>
        <span className={SECTION_TITLE}>Border</span>
        <Toggle id="shape-border" label="Border" on={a.border.enabled} onChange={(on) => setBorder({ enabled: on })} />
        {a.border.enabled && (
          <>
            <Slider id="shape-border-width" layerId={id} label="Width" value={a.border.width} min={0} max={30} step={1} unit="px" onLive={(v, o) => setBorder({ width: v }, o)} />
            <ColorRow id="shape-border-color" label="Colour" value={a.border.color} openField={openField} setOpenField={setOpenField} apply={(hex, o) => setBorder({ color: hex }, o)} />
          </>
        )}
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Shadow</span>
        <Toggle id="shape-shadow" label="Shadow" on={a.shadow.enabled} onChange={(on) => setShadow({ enabled: on })} />
        {a.shadow.enabled && (
          <>
            <Slider id="shape-shadow-blur" layerId={id} label="Blur" value={a.shadow.blur} min={0} max={60} step={1} unit="px" onLive={(v, o) => setShadow({ blur: v }, o)} />
            <Slider id="shape-shadow-x" layerId={id} label="Offset X" value={a.shadow.offsetX} min={-50} max={50} step={1} unit="px" onLive={(v, o) => setShadow({ offsetX: v }, o)} />
            <Slider id="shape-shadow-y" layerId={id} label="Offset Y" value={a.shadow.offsetY} min={-50} max={50} step={1} unit="px" onLive={(v, o) => setShadow({ offsetY: v }, o)} />
            <Slider id="shape-shadow-opacity" layerId={id} label="Opacity" value={a.shadow.opacity} min={0} max={100} step={1} unit="%" onLive={(v, o) => setShadow({ opacity: v }, o)} />
            <ColorRow id="shape-shadow-color" label="Colour" value={a.shadow.color} openField={openField} setOpenField={setOpenField} apply={(hex, o) => setShadow({ color: hex }, o)} />
          </>
        )}
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Animation</span>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="shape-entrance" className={GROUP_LABEL}>Entrance</label>
          <select id="shape-entrance" className={SELECT} value={entrance?.preset || 'none'} onChange={(e) => setEntrance({ preset: e.target.value, duration: entrance?.duration ?? 0.4, easing: entrance?.easing ?? 'ease-out' })}>
            {ANIMATION_TYPES.map((type) => <option key={type} value={type}>{type === 'none' ? 'None' : titleCase(type)}</option>)}
          </select>
        </div>
        {entrance && (
          <>
            <Slider id="shape-entrance-duration" layerId={id} label="Duration" value={entrance.duration} min={0.1} max={2} step={0.05} format={(v) => `${v.toFixed(2)}s`} onLive={(v, o) => setEntrance({ duration: v }, o)} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="shape-entrance-easing" className={GROUP_LABEL}>Easing</label>
              <select id="shape-entrance-easing" className={SELECT} value={entrance.easing} onChange={(e) => setEntrance({ easing: e.target.value })}>
                {EASING_TYPES.map((easing) => <option key={easing} value={easing}>{titleCase(easing)}</option>)}
              </select>
            </div>
          </>
        )}
        <p className={HINT}>Plays from the shape's own start on the timeline.</p>
      </div>
    </>
  );
}

export function ShapeInspector() {
  const [, force] = useState(0);
  useEffect(() => subscribe('*', () => force((n) => n + 1)), []);
  const shapes = appState.shapeLayers || [];
  const selected = shapes.find((s) => s.id === appState.selectedShapeLayerId) || null;

  return (
    <div className="flex flex-col gap-4">
      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Shapes</span>
          <span className="text-[11px] font-semibold text-[var(--accent-color)]">{shapes.length}</span>
        </div>
        <p className={HINT}>Simple shapes over the video for a stretch of the timeline — at the playhead.</p>
        <div className="grid grid-cols-3 gap-2" id="shape-add">
          {SHAPE_KINDS.map((k) => (
            <button key={k} type="button" data-add-shape={k} className={SECONDARY_BTN} onClick={() => shapeLayers.addShapeLayer(k)}>{SHAPE_LABELS[k]}</button>
          ))}
        </div>
        {shapes.length > 0 && (
          <div className="flex flex-col gap-1.5" id="shape-list">
            {shapes.map((s) => (
              <button key={s.id} type="button"
                className={`${ROW_BASE} ${s.id === selected?.id ? 'border-[var(--accent-color)]' : 'border-[var(--border-color)]'}`}
                onClick={() => shapeLayers.selectShapeLayer(s.id)}>
                <span className="text-[10px] font-bold text-[var(--text-muted)]">SHP</span>
                <span className="text-[12px] text-[var(--text-primary)] truncate flex-1">{SHAPE_LABELS[s.kind]}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{s.start.toFixed(1)}s</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected
        ? <ShapeEditor shape={selected} />
        : shapes.length > 0 && (
          <div className={CARD}>
            <span className={SECTION_TITLE}>Nothing selected</span>
            <p className={HINT}>Pick one above, click it on the video, or click its clip on the Shapes lane.</p>
          </div>
        )}
    </div>
  );
}
