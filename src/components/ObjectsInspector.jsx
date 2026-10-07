/**
 * The OBJECTS panel (src/js/components/objectDetection.js): find the objects
 * in the video, see them on the frame, pick one as the target. While it is
 * open the preview shows the detection overlay (objectOverlay.js) — boxes
 * on the paused frame, click one to select it.
 *
 * Picking an object does nothing to the video by itself: it says WHICH
 * object you mean. What to do with it is for later features.
 */
import { useEffect, useState } from 'react';
import { appState, subscribe } from '../js/state.js';
import * as objects from '../js/components/objectDetection.js';
import * as tracking from '../js/components/objectTracking.js';
import * as effects from '../js/components/objectEffects.js';
import * as segmentation from '../js/components/objectSegmentation.js';
import { DETECTION_MODELS, DEFAULT_MODEL_ID } from '../../shared/objects/detections.js';
import { OBJECT_EFFECT_TYPES, OBJECT_EFFECT_LABELS } from '../../shared/objects/effects.js';
import { SELECT, Slider as SharedSlider, Toggle, ColorRow, TimeField } from './LayerInspectorControls.jsx';

const EFFECT_API = { get: effects.getObjectEffect, update: effects.updateObjectEffect };
const Slider = (props) => <SharedSlider api={EFFECT_API} {...props} />;
const pct = (v) => `${Math.round(v * 100)}%`;

/** The selected effect's settings — what each type has, and nothing it doesn't. */
function EffectEditor({ effect }) {
  const [openField, setOpenField] = useState(null);
  const id = effect.id;
  const a = effect.appearance;
  const linked = effects.isEffectLinked(effect);
  const look = (fields, opts) => effects.patchObjectEffectAppearance(id, fields, opts);
  const colour = (label = 'Colour') => (
    <ColorRow id="object-effect-color" label={label} value={a.color} openField={openField} setOpenField={setOpenField} apply={(hex, o) => look({ color: hex }, o)} />
  );
  const padding = <Slider id="object-effect-padding" layerId={id} label="Padding" value={a.padding} min={0} max={0.6} step={0.01} format={pct} onLive={(v, o) => look({ padding: v }, o)} />;
  const roundness = <Slider id="object-effect-roundness" layerId={id} label="Roundness" value={a.cornerRadius} min={0} max={0.5} step={0.01} format={pct} onLive={(v, o) => look({ cornerRadius: v }, o)} />;
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--border-color)] pt-3" id="object-effect-editor" data-type={effect.type} data-linked={linked ? 'yes' : 'no'}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-bold text-[var(--accent-color)]">{effect.label || 'Object'}</span>
        <select id="object-effect-type" className={`${SELECT} w-auto`} value={effect.type} onChange={(e) => effects.updateObjectEffect(id, { type: e.target.value })}>
          {OBJECT_EFFECT_TYPES.map((t) => <option key={t} value={t}>{OBJECT_EFFECT_LABELS[t]}</option>)}
        </select>
      </div>
      {!linked && (
        <p className={HINT} id="object-effect-unlinked">
          Its object is no longer tracked for this video, so it isn’t drawn. Select the object and track it again to bring it back.
        </p>
      )}
      <Toggle id="object-effect-enabled" label="Show" on={effect.enabled} onChange={(on) => effects.updateObjectEffect(id, { enabled: on })} />
      <div className="flex gap-2">
        <TimeField id="object-effect-start" label="Start" value={effect.start} onCommit={(v) => effects.trimObjectEffect(id, 'start', v)} />
        <TimeField id="object-effect-end" label="End" value={effect.end} onCommit={(v) => effects.trimObjectEffect(id, 'end', v)} />
      </div>
      {effect.type === 'outline' && (
        <>
          {colour()}
          <Slider id="object-effect-thickness" layerId={id} label="Thickness" value={a.thickness} min={1} max={40} step={1} unit="px" onLive={(v, o) => look({ thickness: v }, o)} />
          <Slider id="object-effect-opacity" layerId={id} label="Opacity" value={a.opacity} min={0} max={1} step={0.01} format={pct} onLive={(v, o) => look({ opacity: v }, o)} />
          {padding}
          {roundness}
        </>
      )}
      {effect.type === 'glow' && (
        <>
          {colour()}
          <Slider id="object-effect-intensity" layerId={id} label="Intensity" value={a.intensity} min={0} max={1} step={0.01} format={pct} onLive={(v, o) => look({ intensity: v }, o)} />
          <Slider id="object-effect-radius" layerId={id} label="Radius" value={a.radius} min={2} max={120} step={1} unit="px" onLive={(v, o) => look({ radius: v }, o)} />
          <Slider id="object-effect-opacity" layerId={id} label="Opacity" value={a.opacity} min={0} max={1} step={0.01} format={pct} onLive={(v, o) => look({ opacity: v }, o)} />
          {padding}
        </>
      )}
      {effect.type === 'spotlight' && (
        <>
          <Slider id="object-effect-strength" layerId={id} label="Dim the rest" value={a.strength} min={0} max={1} step={0.01} format={pct} onLive={(v, o) => look({ strength: v }, o)} />
          <Slider id="object-effect-feather" layerId={id} label="Soft edge" value={a.feather} min={0} max={200} step={1} unit="px" onLive={(v, o) => look({ feather: v }, o)} />
          {colour('Tint')}
          {padding}
          {roundness}
        </>
      )}
      {effect.type === 'blur' && (
        <>
          <Slider id="object-effect-strength" layerId={id} label="Strength" value={a.strength} min={0} max={1} step={0.01} format={pct} onLive={(v, o) => look({ strength: v }, o)} />
          {padding}
          {roundness}
        </>
      )}
      <Slider id="object-effect-fade" layerId={id} label="Fade in / out" value={effect.fade} min={0} max={1} step={0.05} format={(v) => `${v.toFixed(2)}s`} onLive={(v, o) => effects.updateObjectEffect(id, { fade: v }, o)} />
      <button type="button" id="object-effect-delete" className={BTN} onClick={() => effects.removeObjectEffect(id)}>Delete effect</button>
    </div>
  );
}

/**
 * Effects that FOLLOW a tracked object (shared/objects/effects.js): add one to
 * the selected object once it is tracked; every effect, on every object, is
 * listed here and on the timeline's Effects lane.
 */
function EffectsSection() {
  const track = tracking.getSelectedTrack();
  const all = effects.getObjectEffects();
  const selected = effects.getSelectedObjectEffect();
  if (!track && !all.length) return null;
  return (
    <div className={CARD} id="objects-effects">
      <span className={SECTION_TITLE}>Effects</span>
      {track ? (
        <>
          <p className={HINT}>Follows the selected {track.label?.toLowerCase() || 'object'} wherever it goes — no keyframes. Starts at the playhead.</p>
          <div className="grid grid-cols-2 gap-2">
            {OBJECT_EFFECT_TYPES.map((t) => (
              <button type="button" key={t} id={`objects-effect-add-${t}`} data-add-effect={t} className={BTN} onClick={() => effects.addObjectEffect(t)}>
                + {OBJECT_EFFECT_LABELS[t]}
              </button>
            ))}
          </div>
          <p className={HINT}>Outline, glow, spotlight and blur follow the object’s box — not yet its exact shape.</p>
        </>
      ) : (
        <p className={HINT}>Select a tracked object to add an effect to it.</p>
      )}
      {all.length > 0 && (
        <div className="flex flex-col gap-1.5" id="object-effects-list">
          {all.map((e) => {
            const on = selected?.id === e.id;
            const linked = effects.isEffectLinked(e);
            return (
              <button
                type="button" key={e.id} data-effect-id={e.id}
                className={`${ROW} ${on ? 'border-[var(--accent-color)] text-[var(--accent-color)]' : 'border-[var(--border-color)] text-[var(--text-primary)]'}`}
                onClick={() => effects.selectObjectEffect(on ? null : e.id)}
              >
                <span className="font-semibold">{effects.describeObjectEffect(e)}</span>
                <span className="text-[11px] text-[var(--text-muted)]">{linked ? `${e.start.toFixed(1)}–${e.end.toFixed(1)}s` : 'not tracked'}</span>
              </button>
            );
          })}
        </div>
      )}
      {selected && <EffectEditor effect={selected} />}
    </div>
  );
}

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const BTN = `h-9 flex-1 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]
  disabled:opacity-40 disabled:cursor-default`;
const ROW = `w-full text-left px-3 py-2 rounded-[var(--radius-sm)] border cursor-pointer transition-colors duration-150
  bg-[var(--bg-input)] flex items-center justify-between gap-2 text-[12px]`;

/** Tracking the selected object: start it, watch it, read what it found. */
function TrackSection() {
  const status = appState.trackingStatus || {};
  const running = tracking.isTracking();
  const track = tracking.getSelectedTrack();
  const info = tracking.describeTrack(track);
  const failed = !running && status.state === 'failed' && status.key === tracking.getSelectedTrackKey();
  return (
    <div className="flex flex-col gap-2" id="objects-track" data-state={running ? 'tracking' : track ? track.status : failed ? 'failed' : 'none'}>
      {running && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-[var(--text-primary)]" id="objects-track-status">
            Tracking…{status.total ? ` ${status.done} of about ${status.total} frames` : ''}
          </span>
          <button type="button" id="objects-track-stop" className={`${BTN} flex-none px-3 h-7`} onClick={() => tracking.cancelTracking()}>Stop</button>
        </div>
      )}
      {!running && info && (
        <div className="flex flex-col gap-1" id="objects-track-status">
          <span className="text-[12px] font-semibold text-[var(--text-primary)]">{info.title} · {Math.round(info.confidence * 100)}%</span>
          <span className={HINT}>{info.detail}</span>
          {info.note && <span className={HINT}>{info.note}</span>}
        </div>
      )}
      {!running && failed && (
        <span className="text-[12px] text-[var(--text-primary)]" id="objects-track-status">Tracking failed — {status.message}. Editing works as normal.</span>
      )}
      {!running && !track && !failed && <p className={HINT}>Not tracked yet — follow it through the video to see where it goes.</p>}
      {!running && (
        <button type="button" id="objects-track-start" className={BTN} onClick={() => tracking.trackSelectedObject({ force: !!track })}>
          {track ? 'Re-track' : 'Track object'}
        </button>
      )}
    </div>
  );
}

const duration = (sec) => (sec >= 90 ? `${Math.round(sec / 60)} min` : `${Math.max(1, Math.round(sec))}s`);

const MASK_VIEWS = [['overlay', 'Mask'], ['silhouette', 'Silhouette'], ['boundary', 'Outline'], ['off', 'Off']];

/**
 * Segmenting the tracked object (objectSegmentation.js): which PIXELS are it,
 * over time. Shown once the object is tracked; the mask shows on the frame
 * while this panel is open, in the chosen view — an editing aid, never exported.
 */
function SegmentSection() {
  const track = tracking.getSelectedTrack();
  if (!track) return null;
  const status = appState.segmentationStatus || {};
  const running = segmentation.isSegmenting();
  const record = segmentation.getSelectedSegmentation();
  const info = segmentation.describeSegmentation(record);
  const failed = !running && status.state === 'failed' && !record;
  const view = appState.maskView || 'overlay';
  const estimate = !running && !record ? segmentation.estimateSegmentation() : null;
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--border-color)] pt-3" id="objects-segment" data-state={running ? 'segmenting' : record ? record.status : failed ? 'failed' : 'none'}>
      {running && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-[var(--text-primary)]" id="objects-segment-status">
            Segmenting…{status.total ? ` ${status.done} of about ${status.total} keyframes` : ''}{status.backend ? ` · ${status.backend === 'gpu' ? 'GPU' : 'CPU (slow)'}` : ''}{status.secondsLeft > 0 ? ` · about ${duration(status.secondsLeft)} left` : ''}
          </span>
          <button type="button" id="objects-segment-stop" className={`${BTN} flex-none px-3 h-7`} onClick={() => segmentation.cancelSegmentation()}>Stop</button>
        </div>
      )}
      {!running && info && (
        <div className="flex flex-col gap-1" id="objects-segment-status">
          <span className="text-[12px] font-semibold text-[var(--text-primary)]">{info.title} · {Math.round(info.confidence * 100)}%</span>
          <span className={HINT}>{info.detail}</span>
          {info.note && <span className={HINT}>{info.note}</span>}
        </div>
      )}
      {!running && failed && (
        <span className="text-[12px] text-[var(--text-primary)]" id="objects-segment-status">Segmentation failed — {status.message}. Editing works as normal.</span>
      )}
      {!running && !record && !failed && (
        <p className={HINT} id="objects-segment-estimate">
          Find exactly which pixels are the {track.label?.toLowerCase() || 'object'}, frame by frame.{estimate ? ` About ${estimate.keyframes} keyframes — roughly ${duration(estimate.seconds)} on this device.` : ''} Masks appear as each is done; keep editing meanwhile.
        </p>
      )}
      {!running && (
        <button type="button" id="objects-segment-start" className={BTN} onClick={() => segmentation.segmentSelectedObject({ force: !!record })}>
          {record ? 'Re-segment' : 'Segment object'}
        </button>
      )}
      {record && (
        <div className="flex gap-1" id="objects-mask-views">
          {MASK_VIEWS.map(([v, label]) => (
            <button
              type="button" key={v} id={`objects-mask-view-${v}`} data-mask-view={v}
              className={`h-7 flex-1 rounded-[3px] border text-[11px] font-bold cursor-pointer ${view === v ? 'border-[var(--accent-color)] text-[var(--accent-color)]' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}
              onClick={() => segmentation.setMaskView(v)}
            >{label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ObjectsInspector() {
  const [, force] = useState(0);
  useEffect(() => subscribe('*', () => force((n) => n + 1)), []);
  // The playhead moves without a state change — follow it while the panel is open.
  useEffect(() => {
    const v = document.getElementById('preview-video');
    const tick = () => force((n) => n + 1);
    v?.addEventListener('seeked', tick);
    v?.addEventListener('pause', tick);
    return () => { v?.removeEventListener('seeked', tick); v?.removeEventListener('pause', tick); };
  }, []);
  // The overlay is up exactly while this panel is.
  useEffect(() => {
    objects.setObjectsMode(true);
    return () => objects.setObjectsMode(false);
  }, []);

  const status = appState.objectStatus || {};
  const set = objects.getDetectionSet();
  const source = objects.getDetectionSource();
  const t = document.getElementById('preview-video')?.currentTime ?? 0;
  const here = objects.getDetectionsAt(t);
  const names = here ? objects.displayNames(here.detections) : new Map();
  const selected = objects.getSelectedObject();
  const detecting = status.state === 'detecting';
  const total = set?.frames.reduce((n, f) => n + f.detections.filter((d) => d.confidence >= appState.objectMinConfidence).length, 0) ?? 0;
  const model = DETECTION_MODELS[DEFAULT_MODEL_ID];

  const jumpTo = (time) => {
    const v = document.getElementById('preview-video');
    if (!v) return;
    v.pause();
    v.currentTime = time;
  };

  return (
    <div className="flex flex-col gap-4" id="objects-editor">
      <div className={CARD}>
        <span className={SECTION_TITLE}>Objects</span>
        <p className={HINT}>Find the people and things in your video, then pick the one you mean. Boxes show on the paused frame.</p>
        <div id="objects-status" data-state={status.state || 'idle'} className="flex flex-col gap-1">
          {!source && <span className="text-[12px] text-[var(--text-secondary)]">Add a video first.</span>}
          {source && detecting && (
            <span className="text-[12px] font-semibold text-[var(--text-primary)]">
              Detecting objects…{status.total > 1 ? ` ${status.done} of ${status.total} frames` : ''}
            </span>
          )}
          {source && !detecting && status.state === 'failed' && (
            <span className="text-[12px] text-[var(--text-primary)]">Couldn’t detect objects — {status.message}. Editing works as normal.</span>
          )}
          {source && !detecting && status.state !== 'failed' && set && (
            <span className="text-[12px] font-semibold text-[var(--text-primary)]">
              {total ? `Objects detected · ${total} in ${set.frames.length} frame${set.frames.length === 1 ? '' : 's'}` : `No objects found in ${set.frames.length} frame${set.frames.length === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" id="objects-scan" className={BTN} disabled={!source || detecting} onClick={() => objects.scanVideo()}>Scan video</button>
          <button type="button" id="objects-detect-frame" className={BTN} disabled={!source || detecting} onClick={() => objects.detectCurrentFrame()}>Detect this frame</button>
        </div>
      </div>

      <div className={CARD}>
        <span className={SECTION_TITLE}>In this frame</span>
        {!here && <p className={HINT}>{set?.frames.length ? 'This frame hasn’t been analysed — pause on it, or jump to an analysed frame below.' : 'Nothing analysed yet.'}</p>}
        {here && !here.detections.length && <p className={HINT}>No objects here.</p>}
        {here && here.detections.length > 0 && (
          <div className="flex flex-col gap-1.5" id="objects-list">
            {here.detections.map((d) => {
              const on = selected?.detectionId === d.id;
              return (
                <button
                  type="button" key={d.id} data-detection-id={d.id}
                  className={`${ROW} ${on ? 'border-[var(--accent-color)] text-[var(--accent-color)]' : 'border-[var(--border-color)] text-[var(--text-primary)]'}`}
                  onClick={() => (on ? objects.clearSelectedObject() : objects.selectObject(d))}
                >
                  <span className="font-semibold">{names.get(d.id)}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{Math.round(d.confidence * 100)}%</span>
                </button>
              );
            })}
          </div>
        )}
        {set?.frames.length > 1 && (
          <div className="flex flex-wrap gap-1" id="objects-frames">
            {set.frames.map((f) => (
              <button
                type="button" key={f.time} data-frame-time={f.time}
                className={`h-6 px-1.5 rounded-[3px] border text-[10px] cursor-pointer ${here?.time === f.time ? 'border-[var(--accent-color)] text-[var(--accent-color)]' : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}
                title={`${f.detections.filter((d) => d.confidence >= appState.objectMinConfidence).length} objects`}
                onClick={() => jumpTo(f.time)}
              >
                {f.time.toFixed(1)}s
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={CARD} id="objects-selected">
        <span className={SECTION_TITLE}>Selected object</span>
        {selected ? (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-bold text-[var(--accent-color)]" id="objects-selected-label">{selected.label}</span>
              <span className="text-[11px] text-[var(--text-muted)]">{Math.round(selected.confidence * 100)}% · at {selected.timestamp.toFixed(2)}s</span>
            </div>
            <TrackSection />
            <SegmentSection />
            <div className="flex gap-2">
              <button type="button" className={BTN} onClick={() => jumpTo(selected.timestamp)}>Show</button>
              <button type="button" id="objects-deselect" className={BTN} onClick={() => objects.clearSelectedObject()}>Deselect</button>
            </div>
          </>
        ) : (
          <p className={HINT}>None — click a box on the video, or an object above.</p>
        )}
      </div>

      <EffectsSection />

      <p className={HINT}>Detector: YOLOX-Tiny ({model.license}), runs on this device. Nothing is uploaded.</p>
    </div>
  );
}
