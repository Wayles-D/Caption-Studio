/**
 * Reusable numeric slider + directly-editable value control.
 *
 * Wires a <input type="range"> and its adjacent value badge (a clickable
 * span that becomes a text input) to the SAME min/max/step and the SAME
 * commit path, so dragging the slider and typing an exact value can never
 * disagree about validation or drift out of sync with each other — the
 * range input's own value is the one source of truth for "what's currently
 * selected"; the badge is just an alternate way to set it. Every numeric
 * style control in the sidebar (font size, word spacing, outline width,
 * shadow size/offset/blur, opacities, pop scale, keyword scale, position
 * margin) is wired through this same module rather than five near-identical
 * hand-rolled listeners.
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Tailwind utility classes for the value badge (migration plan's Stage 5 —
// see SidebarInspector.jsx for the JSX that renders the initial badge with
// these same base classes). Exported so this module and the JSX stay in
// sync from one definition instead of two copies drifting apart.
export const BADGE_BASE_CLASSES = 'text-[11px] font-bold text-[var(--accent-wash-text)] bg-[var(--accent-wash-bg)] px-1.5 py-px rounded cursor-text border border-transparent hover:border-[var(--accent-color)] focus-visible:border-[var(--accent-color)] focus-visible:outline-none';
// Swapped in for the badge while it's being directly edited (see beginEdit
// below) — same footprint/colors as the badge it replaces, just wider and
// right-aligned so a typed value doesn't jump the layout.
const BADGE_INPUT_EXTRA_CLASSES = 'font-[family-name:var(--font-main)] w-12 text-right outline-none';
// Brief flash when a typed value was out of range (clamped) or malformed
// (rejected). The `!` (important) prefix mirrors the original CSS's
// `!important` — this transient state must visually win over the badge's
// own base color classes. Deliberately NOT part of the base classes: the
// transition is meant to animate the flash IN (present here) but the
// reversion back to normal 500ms later should snap instantly, exactly like
// the original — removing these classes together removes the transition
// declaration along with the color, so the revert has nothing to animate.
const BADGE_INVALID_CLASSES = '!bg-[rgba(239,68,68,0.25)] !text-[#FCA5A5] transition-colors duration-[400ms]';

/**
 * @param {object} config
 * @param {string} config.sliderId - <input type="range"> element id.
 * @param {string} config.badgeId - Value badge element id (becomes editable on click/Enter).
 * @param {number} config.min
 * @param {number} config.max
 * @param {number} [config.step=1]
 * @param {string} [config.unit='px'] - Suffix shown in the badge (not required when typing a value in).
 * @param {(value:number)=>void} config.onChange - Called with a valid, clamped, step-rounded number in STATE units whenever the user changes the value (drag or direct entry).
 * @param {(displayValue:number)=>number} [config.toState] - Converts the slider/badge's own display-unit value into whatever unit onChange should receive (e.g. Keyword Scale stores a 1.0-3.0 ratio but displays 100-300%).
 * @param {(stateValue:number)=>number} [config.fromState] - Inverse of toState, used by sync() to go from state back to the displayed number.
 * @returns {{ sync:(stateValue:number)=>void }} Call sync() with the current (already preset-fallback-resolved) state value whenever appState changes elsewhere — updates the slider position and badge without re-triggering onChange.
 */
export function initNumericControl(config) {
  const {
    sliderId, badgeId, min, max, step = 1, unit = 'px',
    onChange, toState = (v) => v, fromState = (v) => v
  } = config;

  const slider = document.getElementById(sliderId);
  const badge = document.getElementById(badgeId);
  if (!slider) return { sync() {} };

  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);

  // Avoids float noise (e.g. 14.000000000000002) from repeated /step*step.
  const roundToStep = (value) => Math.round(Math.round(value / step) * step * 1000) / 1000;

  const display = (displayValue) => {
    if (badge) badge.textContent = `${displayValue}${unit}`;
  };

  const flashInvalid = () => {
    if (!badge) return;
    badge.classList.add(...BADGE_INVALID_CLASSES.split(' '));
    setTimeout(() => badge.classList.remove(...BADGE_INVALID_CLASSES.split(' ')), 500);
  };

  const commit = (displayValue) => {
    const clamped = roundToStep(clamp(displayValue, min, max));
    slider.value = String(clamped);
    display(clamped);
    onChange(toState(clamped));
    return clamped;
  };

  slider.addEventListener('input', () => {
    commit(parseFloat(slider.value));
  });

  if (badge) {
    let editingInput = null;

    const beginEdit = () => {
      if (editingInput) return;
      const currentDisplay = parseFloat(slider.value);
      editingInput = document.createElement('input');
      editingInput.type = 'text';
      editingInput.inputMode = 'decimal';
      editingInput.className = `${BADGE_BASE_CLASSES} ${BADGE_INPUT_EXTRA_CLASSES}`;
      editingInput.value = String(currentDisplay);
      badge.replaceWith(editingInput);
      editingInput.focus();
      editingInput.select();

      const endEdit = (shouldCommit) => {
        // Capture + null the closure var BEFORE touching the DOM: removing a
        // focused input fires a synchronous 'blur' event, which would
        // re-enter endEdit via the blur listener below WHILE this same
        // replaceWith call is still in flight — without nulling first, that
        // reentrant call sees a non-null editingInput and tries to
        // replaceWith() the same node a second time mid-removal, which
        // throws ("node to be removed is no longer a child of this node").
        const input = editingInput;
        if (!input) return;
        editingInput = null;

        const raw = input.value.trim();
        input.replaceWith(badge);

        if (!shouldCommit) {
          display(parseFloat(slider.value)); // revert, discard the edit
          return;
        }

        // Empty/malformed input (NaN) never reaches style state — the slider
        // just keeps its last valid value, with a brief invalid flash so the
        // UI stays stable instead of silently accepting garbage.
        const parsed = parseFloat(raw);
        if (raw === '' || Number.isNaN(parsed)) {
          display(parseFloat(slider.value));
          flashInvalid();
          return;
        }

        const wasOutOfRange = parsed < min || parsed > max;
        commit(parsed); // clamps into range rather than rejecting outright
        if (wasOutOfRange) flashInvalid();
      };

      editingInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
      });
      editingInput.addEventListener('blur', () => endEdit(true));
    };

    badge.setAttribute('tabindex', '0');
    badge.setAttribute('role', 'button');
    badge.addEventListener('click', beginEdit);
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); beginEdit(); }
    });
  }

  return {
    sync(stateValue) {
      const displayValue = clamp(roundToStep(fromState(stateValue)), min, max);
      slider.value = String(displayValue);
      display(displayValue);
    }
  };
}
