/**
 * The CANVAS panel (shared/composition.js): the composition's shape and
 * background, and the video as an object inside it — where it sits, how big,
 * which way up, its corners, border and shadow. Built from the same controls
 * as the Image and Shape panels (LayerInspectorControls.jsx), so a slider
 * drag is one undo step here too.
 */
import { useEffect, useState } from 'react';
import { appState, subscribe, updateState } from '../js/state.js';
import * as composition from '../js/components/composition.js';
import { getCurrentVideoValue, setVideoValue } from '../js/components/videoTransform.js';
import { ASPECT_RATIOS, ASPECT_RATIO_LABELS, ASPECT_RATIO_HINTS } from '../../shared/composition.js';
import {
  CARD, SECTION_TITLE, HINT, GROUP_LABEL, SECONDARY_BTN, TOGGLE_BTN_BASE, TOGGLE_BTN_ON, TOGGLE_BTN_OFF,
  Slider, Toggle, ColorRow
} from './LayerInspectorControls.jsx';

// Slider rewind/commit targets: the whole stored value, restored as-is.
const TRANSFORM_API = {
  get: () => JSON.parse(JSON.stringify(appState.videoTransform || {})),
  update: (_id, value, opts) => updateState({ videoTransform: value }, opts)
};
const STYLE_API = {
  get: () => JSON.parse(JSON.stringify(appState.videoStyle ?? null)),
  update: (_id, value, opts) => updateState({ videoStyle: value }, opts)
};

const BACKGROUND_PRESETS = [['white', '#FFFFFF'], ['black', '#000000']];
const POSITIONS = ['center', 'top', 'bottom', 'left', 'right'];

function Choice({ id, on, onClick, title, compact = false, children }) {
  return (
    <button
      type="button" id={id} title={title}
      className={`${TOGGLE_BTN_BASE} ${on ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF}${compact ? ' !text-[12px] !h-8 px-0' : ''}`}
      onClick={onClick}
    >{children}</button>
  );
}

/** A ratio as an element id: '2.35:1' -> '2x35x1' (no ':' or '.' to escape in selectors). */
const ratioId = (key) => key.replace(/[:.]/g, 'x');

export function CanvasInspector() {
  const [, force] = useState(0);
  const [openField, setOpenField] = useState(null);
  useEffect(() => subscribe('*', () => force((n) => n + 1)), []);
  // Keyframed placement changes with the playhead, not only with state.
  useEffect(() => {
    const video = document.getElementById('preview-video');
    const tick = () => force((n) => n + 1);
    video?.addEventListener('seeked', tick);
    return () => video?.removeEventListener('seeked', tick);
  }, []);

  const settings = composition.getCompositionSettings();
  const style = composition.getVideoStyle();
  const bg = settings.background.color;
  const v = (p) => getCurrentVideoValue(p);

  return (
    <div className="flex flex-col gap-4" id="canvas-editor">
      <div className={CARD}>
        <span className={SECTION_TITLE}>Canvas</span>
        <p className={HINT}>The frame everything is placed in — and the size of the exported video. The video sits inside it.</p>
        <span className={GROUP_LABEL}>Aspect ratio</span>
        <div className="grid grid-cols-4 gap-1.5" id="canvas-ratios">
          {Object.keys(ASPECT_RATIOS).map((key) => (
            <Choice
              key={key} id={`canvas-ratio-${ratioId(key)}`} compact title={ASPECT_RATIO_HINTS[key]}
              on={settings.aspectRatio === key} onClick={() => composition.setAspectRatio(key)}
            >
              {ASPECT_RATIO_LABELS[key]}
            </Choice>
          ))}
        </div>
        <span className={GROUP_LABEL}>Background</span>
        <div className="flex gap-2">
          {BACKGROUND_PRESETS.map(([name, hex]) => (
            <Choice key={name} id={`canvas-bg-${name}`} on={bg === hex} onClick={() => composition.setBackgroundColor(hex)}>
              {name === 'white' ? 'White' : 'Black'}
            </Choice>
          ))}
        </div>
        <ColorRow
          id="canvas-bg-color" label="Custom" value={bg} openField={openField} setOpenField={setOpenField}
          apply={(hex, opts) => composition.setBackgroundColor(hex, opts)}
        />
      </div>

      <div className={CARD}>
        <div className="flex items-center justify-between">
          <span className={SECTION_TITLE}>Video</span>
          <button type="button" id="video-reset" className={`${SECONDARY_BTN} px-3 h-7`} onClick={() => composition.resetVideo()}>Reset</button>
        </div>
        <span className={GROUP_LABEL}>Position</span>
        <div className="flex gap-1.5">
          {POSITIONS.map((p) => (
            <button key={p} type="button" id={`video-pos-${p}`} className={`${SECONDARY_BTN} flex-1 px-0 h-8 capitalize`} onClick={() => composition.alignVideo(p)}>{p}</button>
          ))}
        </div>
        <Slider id="video-x" label="X" value={v('positionX')} min={-100} max={100} step={0.5} unit="%" api={TRANSFORM_API}
          onLive={(val, opts) => setVideoValue('positionX', val, opts)} />
        <Slider id="video-y" label="Y" value={v('positionY')} min={-100} max={100} step={0.5} unit="%" api={TRANSFORM_API}
          onLive={(val, opts) => setVideoValue('positionY', val, opts)} />
        <Slider id="video-scale" label="Scale" value={v('scale')} min={0.1} max={3} step={0.01} api={TRANSFORM_API}
          format={(s) => `${Math.round(s * 100)}%`} onLive={(val, opts) => setVideoValue('scale', val, opts)} />
        <Slider id="video-rotation" label="Rotation" value={v('rotation')} min={-180} max={180} step={1} unit="°" api={TRANSFORM_API}
          onLive={(val, opts) => setVideoValue('rotation', val, opts)} />
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>Video style</span>
        <Slider id="video-radius" label="Corner radius" value={style.cornerRadius} min={0} max={50} step={1} unit="%" api={STYLE_API}
          onLive={(val, opts) => composition.patchVideoStyle('cornerRadius', { cornerRadius: val }, opts)} />
        <Toggle id="video-border" label="Border" on={style.border.enabled} onChange={(on) => composition.patchVideoStyle('border', { enabled: on })} />
        {style.border.enabled && (
          <>
            <Slider id="video-border-width" label="Width" value={style.border.width} min={1} max={30} step={1} unit="px" api={STYLE_API}
              onLive={(val, opts) => composition.patchVideoStyle('border', { width: val }, opts)} />
            <Slider id="video-border-opacity" label="Opacity" value={style.border.opacity} min={0} max={100} step={1} unit="%" api={STYLE_API}
              onLive={(val, opts) => composition.patchVideoStyle('border', { opacity: val }, opts)} />
            <ColorRow id="video-border-color" label="Colour" value={style.border.color} openField={openField} setOpenField={setOpenField}
              apply={(hex, opts) => composition.patchVideoStyle('border', { color: hex }, opts)} />
          </>
        )}
        <Toggle id="video-shadow" label="Shadow" on={style.shadow.enabled} onChange={(on) => composition.patchVideoStyle('shadow', { enabled: on })} />
        {style.shadow.enabled && (
          <>
            <Slider id="video-shadow-blur" label="Blur" value={style.shadow.blur} min={0} max={100} step={1} unit="px" api={STYLE_API}
              onLive={(val, opts) => composition.patchVideoStyle('shadow', { blur: val }, opts)} />
            <Slider id="video-shadow-y" label="Offset Y" value={style.shadow.offsetY} min={-60} max={60} step={1} unit="px" api={STYLE_API}
              onLive={(val, opts) => composition.patchVideoStyle('shadow', { offsetY: val }, opts)} />
            <Slider id="video-shadow-x" label="Offset X" value={style.shadow.offsetX} min={-60} max={60} step={1} unit="px" api={STYLE_API}
              onLive={(val, opts) => composition.patchVideoStyle('shadow', { offsetX: val }, opts)} />
            <Slider id="video-shadow-opacity" label="Opacity" value={style.shadow.opacity} min={0} max={100} step={1} unit="%" api={STYLE_API}
              onLive={(val, opts) => composition.patchVideoStyle('shadow', { opacity: val }, opts)} />
            <ColorRow id="video-shadow-color" label="Colour" value={style.shadow.color} openField={openField} setOpenField={setOpenField}
              apply={(hex, opts) => composition.patchVideoStyle('shadow', { color: hex }, opts)} />
          </>
        )}
      </div>
    </div>
  );
}

