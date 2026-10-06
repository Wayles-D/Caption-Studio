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
import { DETECTION_MODELS, DEFAULT_MODEL_ID } from '../../shared/objects/detections.js';

const CARD = 'bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] p-4 flex flex-col gap-3';
const SECTION_TITLE = 'text-xs font-bold uppercase tracking-[0.05em] text-[var(--text-secondary)]';
const HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const BTN = `h-9 flex-1 bg-transparent border border-[var(--border-color)] text-[var(--text-secondary)] font-bold text-xs
  rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-150 hover:border-[var(--accent-color)] hover:text-[var(--accent-color)]
  disabled:opacity-40 disabled:cursor-default`;
const ROW = `w-full text-left px-3 py-2 rounded-[var(--radius-sm)] border cursor-pointer transition-colors duration-150
  bg-[var(--bg-input)] flex items-center justify-between gap-2 text-[12px]`;

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
            <p className={HINT}>This is the object you’ve picked. It isn’t followed through the video yet — that comes with tracking.</p>
            <div className="flex gap-2">
              <button type="button" className={BTN} onClick={() => jumpTo(selected.timestamp)}>Show</button>
              <button type="button" id="objects-deselect" className={BTN} onClick={() => objects.clearSelectedObject()}>Deselect</button>
            </div>
          </>
        ) : (
          <p className={HINT}>None — click a box on the video, or an object above.</p>
        )}
      </div>

      <p className={HINT}>Detector: YOLOX-Tiny ({model.license}), runs on this device. Nothing is uploaded.</p>
    </div>
  );
}
