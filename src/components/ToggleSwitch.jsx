/**
 * Small reusable pill toggle switch — Tailwind port of style.css's former
 * .theme-toggle-label/.theme-slider pair (migration plan's Stage 5). Used by
 * Toolbar's dark/light toggle and SidebarInspector's several on/off toggles
 * (keyword highlighting, active highlight, keyword shadow, keyword outline).
 *
 * The checkbox is visually hidden (Tailwind's `sr-only` — screen-reader-only,
 * the semantic equivalent of the old opacity:0;width:0;height:0 trick) but
 * still a real, focusable, form-participating input; the track/thumb are
 * driven purely by the `peer-checked:` variant on the sibling span, mirroring
 * the original's `input:checked + .theme-slider` adjacent-sibling CSS.
 */
export function ToggleSwitch({ id, defaultChecked, onChange, title }) {
  return (
    <label className="relative inline-block w-11 h-6 cursor-pointer" title={title}>
      <input
        type="checkbox"
        id={id}
        className="peer sr-only"
        defaultChecked={defaultChecked}
        onChange={onChange}
      />
      <span
        className="absolute inset-0 rounded-full border transition-[background-color] duration-300
          bg-[var(--bg-input)] border-[var(--border-color)] peer-checked:bg-[var(--accent-color)]
          before:content-[''] before:absolute before:h-[18px] before:w-[18px] before:left-[2px] before:bottom-[2px]
          before:rounded-full before:bg-[var(--text-secondary)] before:transition-transform before:duration-300
          peer-checked:before:translate-x-[20px] peer-checked:before:bg-white"
      />
    </label>
  );
}
