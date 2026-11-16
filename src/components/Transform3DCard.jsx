/**
 * The 3D card (V2.4.0) — one card for every object that can stand in 3D:
 * text elements, images, shapes and the video (shared/transform3d.js). Each
 * panel passes its object's current 3D settings, how to write them, and the
 * slider `api` it already uses, so a drag is still ONE undo step.
 *
 * Words, not maths: a surface to start from (Flat, Floor, walls, Tilted),
 * then Tilt, Turn, Perspective and Distance, and a hinge picked on a 3×3
 * grid. Spin stays the object's own Rotation in its Transform card.
 */
import { CARD, SECTION_TITLE, HINT, GROUP_LABEL, SECONDARY_BTN, TOGGLE_BTN_BASE, TOGGLE_BTN_ON, TOGGLE_BTN_OFF, Slider, Toggle } from './LayerInspectorControls.jsx';
import { TRANSFORM_3D_PRESETS, TRANSFORM_3D_DEFAULTS, MAX_TILT, matchTransform3dPreset } from '../../shared/transform3d.js';

const HINGES = [
  [0, 0, 'Top left'], [50, 0, 'Top'], [100, 0, 'Top right'],
  [0, 50, 'Left'], [50, 50, 'Centre'], [100, 50, 'Right'],
  [0, 100, 'Bottom left'], [50, 100, 'Bottom'], [100, 100, 'Bottom right']
];

const deg = (v) => `${Math.round(v)}°`;

/**
 * @param {{ idPrefix: string, value: object, onChange: (fields: object, opts?: object) => void,
 *           api: { get: Function, update: Function }, layerId?: string, keyframed?: boolean }} props
 *   value — the 3D settings as shown now (tilts at the playhead when keyframed);
 *   keyframed — the object animates its tilt (the hint then says how editing works).
 */
export function Transform3DCard({ idPrefix, value, onChange, api, layerId, keyframed = false }) {
  const t = value || TRANSFORM_3D_DEFAULTS;
  const preset = matchTransform3dPreset(t);
  const id = (s) => `${idPrefix}-3d-${s}`;
  return (
    <div className={CARD} id={id('card')}>
      <span className={SECTION_TITLE}>3D</span>
      <Toggle id={id('enabled')} label="Place in 3D" on={t.enabled} onChange={(on) => onChange({ enabled: on })} />
      {t.enabled && (
        <>
          <div className="flex flex-col gap-1.5">
            <span className={GROUP_LABEL}>Surface</span>
            <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Surface">
              {TRANSFORM_3D_PRESETS.map((p) => (
                <button
                  key={p.id} type="button" id={id(`preset-${p.id}`)} aria-pressed={preset === p.id}
                  className={`${TOGGLE_BTN_BASE} !h-8 !text-[12px] ${preset === p.id ? TOGGLE_BTN_ON : TOGGLE_BTN_OFF}`}
                  onClick={() => onChange({ ...p.values })}
                >{p.label}</button>
              ))}
              <span
                id={id('preset-custom')}
                className={`${TOGGLE_BTN_BASE} !h-8 !text-[12px] grid place-items-center cursor-default ${preset === 'custom' ? TOGGLE_BTN_ON : 'border-[var(--border-color)] text-[var(--text-muted)]'}`}
              >Custom</span>
            </div>
          </div>
          <Slider id={id('tilt')} layerId={layerId} api={api} label="Tilt (back / forward)" value={t.rotateX} min={-MAX_TILT} max={MAX_TILT} step={1} format={deg}
            onLive={(v, o) => onChange({ rotateX: v }, o)} />
          <Slider id={id('turn')} layerId={layerId} api={api} label="Turn (left / right)" value={t.rotateY} min={-MAX_TILT} max={MAX_TILT} step={1} format={deg}
            onLive={(v, o) => onChange({ rotateY: v }, o)} />
          <Slider id={id('perspective')} layerId={layerId} api={api} label="Perspective" value={t.perspective} min={0} max={100} step={1} unit="%"
            onLive={(v, o) => onChange({ perspective: v }, o)} />
          <Slider id={id('depth')} layerId={layerId} api={api} label="Distance" value={t.depth} min={-50} max={300} step={1} unit="%"
            onLive={(v, o) => onChange({ depth: v }, o)} />
          <div className="flex items-center justify-between gap-3">
            <span className={GROUP_LABEL}>Hinge</span>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label="Hinge point">
              {HINGES.map(([x, y, label]) => {
                const on = Math.abs(t.originX - x) < 0.5 && Math.abs(t.originY - y) < 0.5;
                return (
                  <button
                    key={label} type="button" id={id(`hinge-${x}-${y}`)} title={label} aria-label={`Hinge: ${label}`} aria-pressed={on}
                    className={`w-6 h-6 rounded-[4px] border cursor-pointer grid place-items-center transition-colors duration-150
                      ${on ? 'border-[var(--accent-color)] bg-[var(--accent-wash-bg)]' : 'border-[var(--border-color)] bg-[var(--bg-input)] hover:border-[var(--accent-color)]'}`}
                    onClick={() => onChange({ originX: x, originY: y })}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-[var(--accent-color)]' : 'bg-[var(--text-muted)]'}`} />
                  </button>
                );
              })}
            </div>
          </div>
          <button type="button" id={id('reset')} className={SECONDARY_BTN}
            onClick={() => onChange({ ...TRANSFORM_3D_PRESETS[0].values, perspective: TRANSFORM_3D_DEFAULTS.perspective })}
          >Reset 3D</button>
          <p className={HINT}>
            Tilt leans the top away, like text on a floor; Turn swings one side away, like a wall. The hinge is the edge that stays put.
            {keyframed ? ' Its tilt is animated: changes here set it at the playhead.' : ''}
          </p>
        </>
      )}
    </div>
  );
}
