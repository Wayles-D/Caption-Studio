/**
 * Left Sidebar: Caption Inspector accordion (Typography, Style & Colors,
 * Animation Mode, Position & Spacing, AI Keywords, Keyword Style).
 *
 * React port of the vanilla src/js/components/sidebarInspector.js (see the
 * migration plan's Stage 2) — but unlike Toolbar.jsx/RightInspector.jsx,
 * this component does NOT reimplement the wiring logic in React. The
 * underlying controls (~30 sliders/radios/selects/toggles/color pickers)
 * are individually wired by initSidebarInspector() via plain
 * document.getElementById() lookups and a single subscribe('*', ...)
 * resync — logic that's already independent of how the DOM nodes got
 * there. Reimplementing all of it as controlled React state would be a
 * large rewrite of delicate, already-correct code for zero behavioral
 * benefit, and risks exactly the kind of subtle regression the migration
 * plan says to avoid. Instead, this component renders the exact same
 * markup (converted 1:1 to JSX — same ids, structure) that used to live
 * directly in index.html, then calls the existing initSidebarInspector()
 * once after mount so it finds the same DOM nodes at the same ids it
 * always has. numericControl.js and colorPicker.js (its two dependencies)
 * are untouched apart from their own Tailwind class-string updates (Stage 5).
 *
 * Radios/checkboxes/selects here are intentionally uncontrolled
 * (defaultChecked/defaultValue) — initSidebarInspector()'s own
 * syncSidebarUI() owns their live value going forward, the same
 * ownership split Toolbar.jsx already uses for its project-title-input.
 *
 * Stage 5 (Tailwind styling): the accordion's collapse/expand is still
 * driven by sidebarInspector.js toggling a literal `collapsed` class on
 * the `.accordion-item` (now also carrying Tailwind's `group` marker) —
 * `group-[.collapsed]:` variants on the chevron/body react to that same
 * class instead of a hand-written `.accordion-item.collapsed .foo` rule.
 * Preset buttons and color swatches follow the same pattern via
 * `[&.active]:` for their JS-toggled `active` class.
 */
import { useEffect } from 'react';
import { initSidebarInspector } from '../js/components/sidebarInspector.js';
import { BADGE_BASE_CLASSES } from '../js/components/numericControl.js';
import { ToggleSwitch } from './ToggleSwitch.jsx';

const SETTINGS_GROUP = 'flex flex-col gap-1.5';
const GROUP_LABEL = 'text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-[0.04em]';
const LABEL_JUSTIFY = 'flex items-center justify-between';
const FIELD_HINT = 'text-[11px] text-[var(--text-muted)] m-0';
const SLIDER = `appearance-none w-full h-1.5 rounded-[3px] bg-[var(--bg-input)] outline-none cursor-pointer
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full
  [&::-webkit-slider-thumb]:bg-[var(--accent-color)] [&::-webkit-slider-thumb]:shadow-[0_0_10px_rgba(217,119,87,0.5)]
  [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150
  hover:[&::-webkit-slider-thumb]:scale-[1.2]`;
const SELECT = `w-full h-9 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] text-[var(--text-primary)]
  text-[13px] px-2.5 outline-none cursor-pointer transition-colors duration-200 hover:border-[var(--accent-color)] focus:border-[var(--accent-color)]`;
const RADIO_GRID = 'grid grid-cols-2 gap-1.5 bg-[var(--bg-input)] p-1 rounded-[var(--radius-sm)] border border-[var(--border-color)]';
const RADIO_TAB = 'relative text-center cursor-pointer';
const RADIO_TAB_INPUT = 'peer absolute opacity-0';
const RADIO_TAB_SPAN = `block px-2.5 py-1.5 text-[11px] font-bold text-[var(--text-secondary)] rounded-md transition-all duration-200
  peer-checked:bg-[var(--bg-card)] peer-checked:text-[var(--text-primary)] peer-checked:shadow-[var(--shadow-sm)]`;
const COLOR_PICKER_GRID = 'grid grid-cols-4 gap-2.5';
const COLOR_PICKER_ITEM = 'flex flex-col items-center gap-1.5';
const COLOR_PICKER_ITEM_LABEL = 'text-[10px] font-semibold text-[var(--text-secondary)] text-center';
const COLOR_SWATCH_TRIGGER = `color-swatch-trigger w-8 h-8 rounded-full border-2 border-[var(--border-color)] cursor-pointer p-0
  transition-[transform,border-color] duration-150 hover:scale-[1.08] hover:border-[var(--border-color-hover)]`;
// 'accordion-item'/'accordion-header' carry no styling of their own — kept
// as stable selector hooks for sidebarInspector.js's querySelectorAll('.accordion-header')
// + closest('.accordion-item') collapse-toggle wiring, exactly like
// 'color-swatch-trigger' and 'word-chip' elsewhere in this migration.
const ACCORDION_ITEM = `accordion-item group bg-[var(--bg-card)] border border-[var(--border-color)] rounded-[var(--radius-md)] overflow-hidden
  transition-colors duration-200 hover:border-[var(--border-color-hover)]`;
const ACCORDION_HEADER = `accordion-header w-full py-3.5 px-4 bg-transparent border-0 flex items-center justify-between text-[var(--text-primary)]
  font-[family-name:var(--font-main)] font-semibold text-[13px] cursor-pointer`;
const ACCORDION_TITLE = 'flex items-center gap-2 text-[var(--text-primary)]';
const CHEVRON = 'text-[var(--text-secondary)] transition-transform duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-[.collapsed]:-rotate-90';
// max-h here is only an arbitrary ceiling so `max-height` has a concrete
// value to transition from/to (CSS can't animate to/from `auto`) — it isn't
// meant to actually cap real content. The original CSS used 800px, which
// silently clipped the "Style & Colors" section once Shadow Mode is set to
// Unified (adds 5 more controls, ~1073px of real content — confirmed via
// computed scrollHeight) with NO way to scroll to the hidden remainder,
// since overflow-hidden here has nothing to do with the outer sidebar's own
// scrolling. Raised well past the tallest realistic case so every section's
// real content always fits.
const ACCORDION_BODY = `px-4 pb-4 flex flex-col gap-3.5 max-h-[3000px] opacity-100 overflow-hidden
  [transition:max-height_0.3s_ease,opacity_0.2s_ease,padding_0.2s_ease]
  group-[.collapsed]:max-h-0 group-[.collapsed]:opacity-0 group-[.collapsed]:pb-0`;

function AccordionSection({ icon, title, children }) {
  return (
    <div className={ACCORDION_ITEM}>
      <button type="button" className={ACCORDION_HEADER}>
        <span className={ACCORDION_TITLE}>
          {icon}
          {title}
        </span>
        <svg className={CHEVRON} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <div className={ACCORDION_BODY}>{children}</div>
    </div>
  );
}

export function SidebarInspector() {
  useEffect(() => {
    initSidebarInspector();
  }, []);

  return (
    <div>
      <div className="py-4 px-5 border-b border-[var(--border-color)] flex items-center justify-between">
        <span className="font-bold text-[13px] uppercase tracking-[0.06em] text-[var(--text-secondary)]">Caption Inspector</span>
        <span className="text-[10px] font-bold text-[var(--status)] flex items-center gap-[5px] bg-[var(--status-wash-bg)] px-2 py-[3px] rounded-xl">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--status)] shadow-[0_0_8px_var(--status)] animate-[pulse_1.8s_infinite]" /> LIVE WYSIWYG
        </span>
      </div>

      <div className="p-3 flex flex-col gap-2.5">

        {/* 1. Typography Section */}
        <AccordionSection
          title="Typography"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>}
        >
          <div className={SETTINGS_GROUP}>
            <label className={GROUP_LABEL}>Caption Mode</label>
            <div className={`${RADIO_GRID} grid-cols-3`}>
              <label className={RADIO_TAB}>
                <input type="radio" name="caption-mode" value="sentence" className={RADIO_TAB_INPUT} defaultChecked />
                <span className={RADIO_TAB_SPAN}>Sentence</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="caption-mode" value="word" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Word</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="caption-mode" value="rolling-stack" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Rolling Stack</span>
              </label>
            </div>
            <p className={FIELD_HINT}>Word mode shows exactly one transcript word at a time instead of the full caption line. Rolling Stack shows normal words on top and the current keyword below, rolling forward as speech continues. "Bold Social" fonts below work well here.</p>
          </div>

          <div className={SETTINGS_GROUP} id="rolling-stack-settings" style={{ display: 'none' }}>
            <label className={GROUP_LABEL}>Words per Layer</label>
            <div className={RADIO_GRID}>
              <label className={RADIO_TAB}>
                <input type="radio" name="rolling-stack-layer-count" value="2" className={RADIO_TAB_INPUT} defaultChecked />
                <span className={RADIO_TAB_SPAN}>2</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="rolling-stack-layer-count" value="3" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>3</span>
              </label>
            </div>
            <label className={GROUP_LABEL} style={{ marginTop: '12px' }}>Layer Alignment</label>
            <div className={RADIO_GRID}>
              <label className={RADIO_TAB}>
                <input type="radio" name="rolling-stack-alignment" value="left" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Left</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="rolling-stack-alignment" value="center" className={RADIO_TAB_INPUT} defaultChecked />
                <span className={RADIO_TAB_SPAN}>Center</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="rolling-stack-alignment" value="right" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Right</span>
              </label>
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <label htmlFor="font-family-select" className={GROUP_LABEL}>Font Family</label>
            <select id="font-family-select" className={SELECT} defaultValue="Montserrat">
              <optgroup label="Modern Sans">
                <option value="Inter">Inter</option>
                <option value="Outfit">Outfit</option>
                <option value="Plus Jakarta Sans">Plus Jakarta Sans</option>
                <option value="Space Grotesk">Space Grotesk</option>
              </optgroup>
              <optgroup label="Bold Social">
                <option value="Anton">Anton</option>
                <option value="Bebas Neue">Bebas Neue</option>
                <option value="League Spartan">League Spartan</option>
                <option value="Archivo Black">Archivo Black</option>
                <option value="Lilita One">Lilita One</option>
              </optgroup>
              <optgroup label="Tall / Word Mode">
                <option value="Goldnic">Goldnic</option>
                <option value="Dominates">Dominates</option>
                <option value="Pocity">Pocity</option>
                <option value="Druk Wide">Druk Wide</option>
              </optgroup>
              <optgroup label="Premium">
                <option value="Montserrat">Montserrat (Default)</option>
                <option value="Poppins">Poppins</option>
                <option value="Lexend">Lexend</option>
                <option value="Rubik">Rubik</option>
              </optgroup>
              <optgroup label="Editorial & Script">
                <option value="PP Editorial New">PP Editorial New</option>
              </optgroup>
            </select>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Font Size</span>
              <span className={BADGE_BASE_CLASSES} id="val-font-size">14px</span>
            </div>
            <input type="range" id="input-font-size" min="8" max="120" defaultValue="14" className={SLIDER} />
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Word Spacing</span>
              <span className={BADGE_BASE_CLASSES} id="val-word-spacing">4px</span>
            </div>
            <input type="range" id="input-word-spacing" min="0" max="60" defaultValue="4" className={SLIDER} />
          </div>

          <div className={SETTINGS_GROUP}>
            <label className={GROUP_LABEL}>Text Case</label>
            <div className={RADIO_GRID}>
              <label className={RADIO_TAB}>
                <input type="radio" name="text-case" value="uppercase" className={RADIO_TAB_INPUT} defaultChecked />
                <span className={RADIO_TAB_SPAN}>UPPERCASE</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="text-case" value="normal" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Sentence</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="text-case" value="lowercase" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>lowercase</span>
              </label>
            </div>
          </div>
        </AccordionSection>

        {/* 2. Style & Presets Section */}
        <AccordionSection
          title="Style & Colors"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20" /></svg>}
        >
          <div className={SETTINGS_GROUP}>
            <label className={GROUP_LABEL}>Preset Profile</label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="preset-btn active bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 cursor-pointer transition-all duration-200 hover:border-[var(--accent-color)] hover:bg-[rgba(217,119,87,0.08)] [&.active]:border-[var(--accent-color)] [&.active]:bg-[rgba(217,119,87,0.08)]" data-preset="bold-yellow">
                <span className="text-[11px] font-extrabold block text-center text-[#FEF08A] [text-shadow:0_0_4px_#000]">YELLOW</span>
              </button>
              <button type="button" className="preset-btn bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 cursor-pointer transition-all duration-200 hover:border-[var(--accent-color)] hover:bg-[rgba(217,119,87,0.08)] [&.active]:border-[var(--accent-color)] [&.active]:bg-[rgba(217,119,87,0.08)]" data-preset="caps-white">
                <span className="text-[11px] font-extrabold block text-center text-white [text-shadow:0_0_4px_#000]">WHITE</span>
              </button>
              <button type="button" className="preset-btn bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 cursor-pointer transition-all duration-200 hover:border-[var(--accent-color)] hover:bg-[rgba(217,119,87,0.08)] [&.active]:border-[var(--accent-color)] [&.active]:bg-[rgba(217,119,87,0.08)]" data-preset="bg-black">
                <span className="text-[11px] font-extrabold block text-center text-white bg-black p-0.5 rounded-sm">BOXED</span>
              </button>
              <button type="button" className="preset-btn bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 cursor-pointer transition-all duration-200 hover:border-[var(--accent-color)] hover:bg-[rgba(217,119,87,0.08)] [&.active]:border-[var(--accent-color)] [&.active]:bg-[rgba(217,119,87,0.08)]" data-preset="signature-v1">
                <span className="text-[11px] font-extrabold block text-center text-[#FFD60A] [font-family:Poppins,sans-serif] [text-shadow:1px_1px_3px_rgba(0,0,0,0.6)]">WAYLES</span>
              </button>
              <button type="button" className="preset-btn bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 cursor-pointer transition-all duration-200 hover:border-[var(--accent-color)] hover:bg-[rgba(217,119,87,0.08)] [&.active]:border-[var(--accent-color)] [&.active]:bg-[rgba(217,119,87,0.08)]" data-preset="wayles-poppins">
                <span className="text-[11px] font-extrabold block text-center text-white [font-family:Poppins,sans-serif] font-bold [text-shadow:1px_1px_3px_rgba(0,0,0,0.6)]">POPPINS</span>
              </button>
              <button type="button" className="preset-btn bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 cursor-pointer transition-all duration-200 hover:border-[var(--accent-color)] hover:bg-[rgba(217,119,87,0.08)] [&.active]:border-[var(--accent-color)] [&.active]:bg-[rgba(217,119,87,0.08)]" data-preset="wayles-pen">
                <span className="text-[11px] font-extrabold block text-center text-white [font-family:'PP_Editorial_New',serif] italic [text-shadow:1px_1px_3px_rgba(0,0,0,0.6)]">PEN</span>
              </button>
              <button type="button" className="preset-btn bg-[var(--bg-input)] border border-[var(--border-color)] rounded-[var(--radius-sm)] p-2 cursor-pointer transition-all duration-200 hover:border-[var(--accent-color)] hover:bg-[rgba(217,119,87,0.08)] [&.active]:border-[var(--accent-color)] [&.active]:bg-[rgba(217,119,87,0.08)]" data-preset="poppins-editorial">
                <span className="text-[11px] font-extrabold block text-center text-white [font-family:Poppins,sans-serif] font-bold [text-shadow:1px_1px_3px_rgba(0,0,0,0.6)]">EDIT</span>
              </button>
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <label className={GROUP_LABEL}>Custom Palette</label>
            <div className={COLOR_PICKER_GRID}>
              <div className={COLOR_PICKER_ITEM}>
                <label id="label-color-active-word" className={COLOR_PICKER_ITEM_LABEL}>Active</label>
                <button type="button" className={COLOR_SWATCH_TRIGGER} id="color-active-word" data-color-key="activeWordColor" aria-haspopup="true" aria-labelledby="label-color-active-word" />
              </div>
              <div className={COLOR_PICKER_ITEM}>
                <label id="label-color-inactive-word" className={COLOR_PICKER_ITEM_LABEL}>Text</label>
                <button type="button" className={COLOR_SWATCH_TRIGGER} id="color-inactive-word" data-color-key="inactiveWordColor" aria-haspopup="true" aria-labelledby="label-color-inactive-word" />
              </div>
              <div className={COLOR_PICKER_ITEM}>
                <label id="label-color-outline" className={COLOR_PICKER_ITEM_LABEL}>Outline</label>
                <button type="button" className={COLOR_SWATCH_TRIGGER} id="color-outline" data-color-key="outlineColor" aria-haspopup="true" aria-labelledby="label-color-outline" />
              </div>
              <div className={COLOR_PICKER_ITEM}>
                <label id="label-color-background" className={COLOR_PICKER_ITEM_LABEL}>Box</label>
                <button type="button" className={COLOR_SWATCH_TRIGGER} id="color-background" data-color-key="backgroundColor" aria-haspopup="true" aria-labelledby="label-color-background" />
              </div>
              <div className={COLOR_PICKER_ITEM} id="shadow-color-item">
                <label id="label-color-shadow" className={COLOR_PICKER_ITEM_LABEL}>Shadow</label>
                <button type="button" className={COLOR_SWATCH_TRIGGER} id="color-shadow" data-color-key="shadowColor" aria-haspopup="true" aria-labelledby="label-color-shadow" />
              </div>
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Outline Width</span>
              <span className={BADGE_BASE_CLASSES} id="val-outline-size">6px</span>
            </div>
            <input type="range" id="input-outline-size" min="0" max="50" defaultValue="6" className={SLIDER} />
            <p className={FIELD_HINT}>Set to 0 to disable the outline completely. Has no effect while a Box color is active.</p>
          </div>

          <div className={SETTINGS_GROUP}>
            <label className={GROUP_LABEL}>Shadow Mode</label>
            <div className={RADIO_GRID}>
              <label className={RADIO_TAB}>
                <input type="radio" name="shadow-mode" value="none" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>None</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="shadow-mode" value="individual" className={RADIO_TAB_INPUT} defaultChecked />
                <span className={RADIO_TAB_SPAN}>Individual</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="shadow-mode" value="unified" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Unified</span>
              </label>
            </div>
            <p className={FIELD_HINT}>Individual gives each character its own shadow. Unified renders one continuous shadow behind the whole caption.</p>
          </div>

          <div id="individual-shadow-controls" className="flex flex-col gap-3.5">
            <div className={SETTINGS_GROUP}>
              <div className={LABEL_JUSTIFY}>
                <span className={GROUP_LABEL}>Shadow Intensity</span>
                <span className={BADGE_BASE_CLASSES} id="val-shadow-size">0px</span>
              </div>
              <input type="range" id="input-shadow-size" min="0" max="100" defaultValue="0" className={SLIDER} />
            </div>

            <div className={SETTINGS_GROUP}>
              <div className={LABEL_JUSTIFY}>
                <span className={GROUP_LABEL}>Shadow Offset X</span>
                <span className={BADGE_BASE_CLASSES} id="val-shadow-offset-x">0px</span>
              </div>
              <input type="range" id="input-shadow-offset-x" min="-100" max="100" defaultValue="0" className={SLIDER} />
            </div>

            <div className={SETTINGS_GROUP}>
              <div className={LABEL_JUSTIFY}>
                <span className={GROUP_LABEL}>Shadow Offset Y</span>
                <span className={BADGE_BASE_CLASSES} id="val-shadow-offset-y">0px</span>
              </div>
              <input type="range" id="input-shadow-offset-y" min="-100" max="100" defaultValue="0" className={SLIDER} />
            </div>
          </div>

          <div id="unified-shadow-controls" hidden className="flex flex-col gap-3.5">
            <div className={SETTINGS_GROUP}>
              <label className={GROUP_LABEL}>Unified Shadow Color</label>
              <div className={COLOR_PICKER_GRID}>
                <div className={COLOR_PICKER_ITEM}>
                  <label id="label-color-unified-shadow" className={COLOR_PICKER_ITEM_LABEL}>Shadow</label>
                  <button type="button" className={COLOR_SWATCH_TRIGGER} id="color-unified-shadow" data-color-key="unifiedShadowColor" aria-haspopup="true" aria-labelledby="label-color-unified-shadow" />
                </div>
              </div>
            </div>

            <div className={SETTINGS_GROUP}>
              <div className={LABEL_JUSTIFY}>
                <span className={GROUP_LABEL}>Shadow Opacity</span>
                <span className={BADGE_BASE_CLASSES} id="val-unified-shadow-opacity">45%</span>
              </div>
              <input type="range" id="input-unified-shadow-opacity" min="0" max="100" defaultValue="45" className={SLIDER} />
            </div>

            <div className={SETTINGS_GROUP}>
              <div className={LABEL_JUSTIFY}>
                <span className={GROUP_LABEL}>Shadow Blur</span>
                <span className={BADGE_BASE_CLASSES} id="val-unified-shadow-blur">6px</span>
              </div>
              <input type="range" id="input-unified-shadow-blur" min="0" max="100" defaultValue="6" className={SLIDER} />
            </div>

            <div className={SETTINGS_GROUP}>
              <div className={LABEL_JUSTIFY}>
                <span className={GROUP_LABEL}>Shadow Offset X</span>
                <span className={BADGE_BASE_CLASSES} id="val-unified-shadow-offset-x">0px</span>
              </div>
              <input type="range" id="input-unified-shadow-offset-x" min="-100" max="100" defaultValue="0" className={SLIDER} />
            </div>

            <div className={SETTINGS_GROUP}>
              <div className={LABEL_JUSTIFY}>
                <span className={GROUP_LABEL}>Shadow Offset Y</span>
                <span className={BADGE_BASE_CLASSES} id="val-unified-shadow-offset-y">4px</span>
              </div>
              <input type="range" id="input-unified-shadow-offset-y" min="-100" max="100" defaultValue="4" className={SLIDER} />
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Text Opacity</span>
              <span className={BADGE_BASE_CLASSES} id="val-text-opacity">100%</span>
            </div>
            <input type="range" id="input-text-opacity" min="0" max="100" defaultValue="100" className={SLIDER} />
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Background Opacity</span>
              <span className={BADGE_BASE_CLASSES} id="val-background-opacity">100%</span>
            </div>
            <input type="range" id="input-background-opacity" min="0" max="100" defaultValue="100" className={SLIDER} />
            <p className={FIELD_HINT}>Only visible when a Box color is active.</p>
          </div>
        </AccordionSection>

        {/* 3. Animation Modes Section */}
        <AccordionSection
          title="Animation Mode"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>}
        >
          <div className={SETTINGS_GROUP}>
            <div className={RADIO_GRID}>
              <label className={RADIO_TAB}>
                <input type="radio" name="anim-mode" value="karaoke" className={RADIO_TAB_INPUT} defaultChecked />
                <span className={RADIO_TAB_SPAN}>Karaoke</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="anim-mode" value="pop" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Pop</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="anim-mode" value="instant" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Instant</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="anim-mode" value="typewriter" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Typewriter</span>
              </label>
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Pop Scaling</span>
              <span className={BADGE_BASE_CLASSES} id="val-pop-scale">118%</span>
            </div>
            <input type="range" id="input-pop-scale" min="100" max="300" defaultValue="118" className={SLIDER} />
          </div>
        </AccordionSection>

        {/* 4. Position & Offset Section */}
        <AccordionSection
          title="Position & Spacing"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg>}
        >
          <div className={SETTINGS_GROUP}>
            <label className={GROUP_LABEL}>Vertical Alignment</label>
            <div className={RADIO_GRID}>
              <label className={RADIO_TAB}>
                <input type="radio" name="sub-pos" value="top" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Top</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="sub-pos" value="center" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Center</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="sub-pos" value="bottom" className={RADIO_TAB_INPUT} defaultChecked />
                <span className={RADIO_TAB_SPAN}>Bottom</span>
              </label>
              <label className={RADIO_TAB}>
                <input type="radio" name="sub-pos" value="manual" className={RADIO_TAB_INPUT} />
                <span className={RADIO_TAB_SPAN}>Manual</span>
              </label>
            </div>
            <p className={FIELD_HINT} id="manual-pos-hint" hidden>Drag the caption directly in the preview to reposition it.</p>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Vertical Offset</span>
              <span className={BADGE_BASE_CLASSES} id="val-margin-v">300px</span>
            </div>
            <input type="range" id="input-margin-v" min="0" max="1900" defaultValue="300" className={SLIDER} />
          </div>
        </AccordionSection>

        {/* 5. AI Keyword Highlighting Section */}
        <AccordionSection
          title="AI Keywords"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>}
        >
          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Highlight Important Words</span>
              <ToggleSwitch id="toggle-keyword-highlighting" defaultChecked title="Toggle AI keyword highlighting" />
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <label className={GROUP_LABEL}>Keyword Color</label>
            <div className={COLOR_PICKER_GRID}>
              <div className={COLOR_PICKER_ITEM}>
                <label id="label-color-keyword" className={COLOR_PICKER_ITEM_LABEL}>Color</label>
                <button type="button" className={COLOR_SWATCH_TRIGGER} id="color-keyword" data-color-key="keywordColor" aria-haspopup="true" aria-labelledby="label-color-keyword" />
              </div>
            </div>
          </div>
        </AccordionSection>

        {/* 6. Keyword Style Section (keyword-driven presets, e.g. WAYLES) */}
        <AccordionSection
          title="Keyword Style"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>}
        >
          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Active Word Highlight</span>
              <ToggleSwitch id="toggle-active-highlight" defaultChecked title="Toggle the base active/inactive word highlight" />
            </div>
            <p className={FIELD_HINT}>Disabled by default on keyword-driven presets like WAYLES, where keyword styling is the primary emphasis system. Can be re-enabled manually.</p>
          </div>

          <div className={SETTINGS_GROUP}>
            <label htmlFor="select-keyword-font" className={GROUP_LABEL}>Keyword Font</label>
            <select id="select-keyword-font" className={SELECT} defaultValue="">
              <option value="">Preset Default</option>
              <option value="Poppins">Poppins</option>
              <option value="PP Editorial New">PP Editorial New</option>
              <option value="Montserrat">Montserrat</option>
              <option value="Bebas Neue">Bebas Neue</option>
              <option value="Anton">Anton</option>
              <option value="Inter">Inter</option>
              <option value="Caveat">Caveat</option>
            </select>
          </div>

          <div className={SETTINGS_GROUP}>
            <label htmlFor="select-keyword-weight" className={GROUP_LABEL}>Keyword Weight</label>
            <select id="select-keyword-weight" className={SELECT} defaultValue="">
              <option value="">Preset Default</option>
              <option value="400">Regular (400)</option>
              <option value="600">Semi-Bold (600)</option>
              <option value="700">Bold (700)</option>
              <option value="800">Extra-Bold (800)</option>
              <option value="900">Black (900)</option>
            </select>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Keyword Scale</span>
              <span className={BADGE_BASE_CLASSES} id="val-keyword-scale">120%</span>
            </div>
            <input type="range" id="input-keyword-scale" min="100" max="300" defaultValue="120" className={SLIDER} />
          </div>

          <div className={SETTINGS_GROUP}>
            <label htmlFor="select-keyword-animation" className={GROUP_LABEL}>Keyword Animation</label>
            <select id="select-keyword-animation" className={SELECT} defaultValue="pop">
              <option value="pop">Pop</option>
              <option value="none">None</option>
            </select>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Keyword Shadow</span>
              <ToggleSwitch id="toggle-keyword-shadow" title="Toggle a soft shadow on keyword words" />
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Keyword Outline</span>
              <ToggleSwitch id="toggle-keyword-outline" title="Toggle an outline on keyword words" />
            </div>
          </div>

          <div className={SETTINGS_GROUP}>
            <div className={LABEL_JUSTIFY}>
              <span className={GROUP_LABEL}>Keyword Opacity</span>
              <span className={BADGE_BASE_CLASSES} id="val-keyword-opacity">100%</span>
            </div>
            <input type="range" id="input-keyword-opacity" min="0" max="100" defaultValue="100" className={SLIDER} />
          </div>
        </AccordionSection>

      </div>
    </div>
  );
}
