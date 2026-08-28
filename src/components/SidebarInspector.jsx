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
 * markup (converted 1:1 to JSX — same ids, classes, structure) that used
 * to live directly in index.html, then calls the existing
 * initSidebarInspector() once after mount so it finds the same DOM nodes
 * at the same ids it always has. numericControl.js and colorPicker.js
 * (its two dependencies) are untouched.
 *
 * Radios/checkboxes/selects here are intentionally uncontrolled
 * (defaultChecked/defaultValue) — initSidebarInspector()'s own
 * syncSidebarUI() owns their live value going forward, the same
 * ownership split Toolbar.jsx already uses for its project-title-input.
 */
import { useEffect } from 'react';
import { initSidebarInspector } from '../js/components/sidebarInspector.js';

export function SidebarInspector() {
  useEffect(() => {
    initSidebarInspector();
  }, []);

  return (
    <div>
      <div className="sidebar-header">
        <span className="sidebar-title">Caption Inspector</span>
        <span className="live-indicator"><span className="pulse-dot" /> LIVE WYSIWYG</span>
      </div>

      <div className="accordion-container">

        {/* 1. Typography Section */}
        <div className="accordion-item">
          <button type="button" className="accordion-header">
            <span className="accordion-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>
              Typography
            </span>
            <svg className="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <div className="accordion-body">
            <div className="settings-group">
              <label className="group-label">Caption Mode</label>
              <div className="radio-toggle-grid caption-mode-grid">
                <label className="radio-tab">
                  <input type="radio" name="caption-mode" value="sentence" defaultChecked />
                  <span>Sentence</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="caption-mode" value="word" />
                  <span>Word</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="caption-mode" value="rolling-stack" />
                  <span>Rolling Stack</span>
                </label>
              </div>
              <p className="field-hint">Word mode shows exactly one transcript word at a time instead of the full caption line. Rolling Stack shows normal words on top and the current keyword below, rolling forward as speech continues. "Bold Social" fonts below work well here.</p>
            </div>

            <div className="settings-group" id="rolling-stack-settings" style={{ display: 'none' }}>
              <label className="group-label">Words per Layer</label>
              <div className="radio-toggle-grid">
                <label className="radio-tab">
                  <input type="radio" name="rolling-stack-layer-count" value="2" defaultChecked />
                  <span>2</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="rolling-stack-layer-count" value="3" />
                  <span>3</span>
                </label>
              </div>
              <label className="group-label" style={{ marginTop: '12px' }}>Layer Alignment</label>
              <div className="radio-toggle-grid">
                <label className="radio-tab">
                  <input type="radio" name="rolling-stack-alignment" value="left" />
                  <span>Left</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="rolling-stack-alignment" value="center" defaultChecked />
                  <span>Center</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="rolling-stack-alignment" value="right" />
                  <span>Right</span>
                </label>
              </div>
            </div>

            <div className="settings-group">
              <label htmlFor="font-family-select" className="group-label">Font Family</label>
              <select id="font-family-select" className="select-control" defaultValue="Montserrat">
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

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Font Size</span>
                <span className="group-value-badge" id="val-font-size">14px</span>
              </div>
              <input type="range" id="input-font-size" min="8" max="120" defaultValue="14" className="slider-control" />
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Word Spacing</span>
                <span className="group-value-badge" id="val-word-spacing">4px</span>
              </div>
              <input type="range" id="input-word-spacing" min="0" max="60" defaultValue="4" className="slider-control" />
            </div>

            <div className="settings-group">
              <label className="group-label">Text Case</label>
              <div className="radio-toggle-grid">
                <label className="radio-tab">
                  <input type="radio" name="text-case" value="uppercase" defaultChecked />
                  <span>UPPERCASE</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="text-case" value="normal" />
                  <span>Sentence</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="text-case" value="lowercase" />
                  <span>lowercase</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* 2. Style & Presets Section */}
        <div className="accordion-item">
          <button type="button" className="accordion-header">
            <span className="accordion-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20" /></svg>
              Style & Colors
            </span>
            <svg className="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <div className="accordion-body">
            <div className="settings-group">
              <label className="group-label">Preset Profile</label>
              <div className="preset-grid-compact">
                <button type="button" className="preset-btn active" data-preset="bold-yellow">
                  <span className="preset-preview bold-yellow-preview">YELLOW</span>
                </button>
                <button type="button" className="preset-btn" data-preset="caps-white">
                  <span className="preset-preview caps-white-preview">WHITE</span>
                </button>
                <button type="button" className="preset-btn" data-preset="bg-black">
                  <span className="preset-preview bg-black-preview">BOXED</span>
                </button>
                <button type="button" className="preset-btn" data-preset="signature-v1">
                  <span className="preset-preview signature-v1-preview">WAYLES</span>
                </button>
                <button type="button" className="preset-btn" data-preset="wayles-poppins">
                  <span className="preset-preview wayles-poppins-preview">POPPINS</span>
                </button>
                <button type="button" className="preset-btn" data-preset="wayles-pen">
                  <span className="preset-preview wayles-pen-preview">PEN</span>
                </button>
                <button type="button" className="preset-btn" data-preset="poppins-editorial">
                  <span className="preset-preview poppins-editorial-preview">EDIT</span>
                </button>
              </div>
            </div>

            <div className="settings-group">
              <label className="group-label">Custom Palette</label>
              <div className="color-picker-grid">
                <div className="color-picker-item">
                  <label id="label-color-active-word">Active</label>
                  <button type="button" className="color-swatch-trigger" id="color-active-word" data-color-key="activeWordColor" aria-haspopup="true" aria-labelledby="label-color-active-word" />
                </div>
                <div className="color-picker-item">
                  <label id="label-color-inactive-word">Text</label>
                  <button type="button" className="color-swatch-trigger" id="color-inactive-word" data-color-key="inactiveWordColor" aria-haspopup="true" aria-labelledby="label-color-inactive-word" />
                </div>
                <div className="color-picker-item">
                  <label id="label-color-outline">Outline</label>
                  <button type="button" className="color-swatch-trigger" id="color-outline" data-color-key="outlineColor" aria-haspopup="true" aria-labelledby="label-color-outline" />
                </div>
                <div className="color-picker-item">
                  <label id="label-color-background">Box</label>
                  <button type="button" className="color-swatch-trigger" id="color-background" data-color-key="backgroundColor" aria-haspopup="true" aria-labelledby="label-color-background" />
                </div>
                <div className="color-picker-item" id="shadow-color-item">
                  <label id="label-color-shadow">Shadow</label>
                  <button type="button" className="color-swatch-trigger" id="color-shadow" data-color-key="shadowColor" aria-haspopup="true" aria-labelledby="label-color-shadow" />
                </div>
              </div>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Outline Width</span>
                <span className="group-value-badge" id="val-outline-size">6px</span>
              </div>
              <input type="range" id="input-outline-size" min="0" max="50" defaultValue="6" className="slider-control" />
              <p className="field-hint">Set to 0 to disable the outline completely. Has no effect while a Box color is active.</p>
            </div>

            <div className="settings-group">
              <label className="group-label">Shadow Mode</label>
              <div className="radio-toggle-grid">
                <label className="radio-tab">
                  <input type="radio" name="shadow-mode" value="none" />
                  <span>None</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="shadow-mode" value="individual" defaultChecked />
                  <span>Individual</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="shadow-mode" value="unified" />
                  <span>Unified</span>
                </label>
              </div>
              <p className="field-hint">Individual gives each character its own shadow. Unified renders one continuous shadow behind the whole caption.</p>
            </div>

            <div id="individual-shadow-controls">
              <div className="settings-group">
                <div className="label-justify">
                  <span className="group-label">Shadow Intensity</span>
                  <span className="group-value-badge" id="val-shadow-size">0px</span>
                </div>
                <input type="range" id="input-shadow-size" min="0" max="100" defaultValue="0" className="slider-control" />
              </div>

              <div className="settings-group">
                <div className="label-justify">
                  <span className="group-label">Shadow Offset X</span>
                  <span className="group-value-badge" id="val-shadow-offset-x">0px</span>
                </div>
                <input type="range" id="input-shadow-offset-x" min="-100" max="100" defaultValue="0" className="slider-control" />
              </div>

              <div className="settings-group">
                <div className="label-justify">
                  <span className="group-label">Shadow Offset Y</span>
                  <span className="group-value-badge" id="val-shadow-offset-y">0px</span>
                </div>
                <input type="range" id="input-shadow-offset-y" min="-100" max="100" defaultValue="0" className="slider-control" />
              </div>
            </div>

            <div id="unified-shadow-controls" hidden>
              <div className="settings-group">
                <label className="group-label">Unified Shadow Color</label>
                <div className="color-picker-grid">
                  <div className="color-picker-item">
                    <label id="label-color-unified-shadow">Shadow</label>
                    <button type="button" className="color-swatch-trigger" id="color-unified-shadow" data-color-key="unifiedShadowColor" aria-haspopup="true" aria-labelledby="label-color-unified-shadow" />
                  </div>
                </div>
              </div>

              <div className="settings-group">
                <div className="label-justify">
                  <span className="group-label">Shadow Opacity</span>
                  <span className="group-value-badge" id="val-unified-shadow-opacity">45%</span>
                </div>
                <input type="range" id="input-unified-shadow-opacity" min="0" max="100" defaultValue="45" className="slider-control" />
              </div>

              <div className="settings-group">
                <div className="label-justify">
                  <span className="group-label">Shadow Blur</span>
                  <span className="group-value-badge" id="val-unified-shadow-blur">6px</span>
                </div>
                <input type="range" id="input-unified-shadow-blur" min="0" max="100" defaultValue="6" className="slider-control" />
              </div>

              <div className="settings-group">
                <div className="label-justify">
                  <span className="group-label">Shadow Offset X</span>
                  <span className="group-value-badge" id="val-unified-shadow-offset-x">0px</span>
                </div>
                <input type="range" id="input-unified-shadow-offset-x" min="-100" max="100" defaultValue="0" className="slider-control" />
              </div>

              <div className="settings-group">
                <div className="label-justify">
                  <span className="group-label">Shadow Offset Y</span>
                  <span className="group-value-badge" id="val-unified-shadow-offset-y">4px</span>
                </div>
                <input type="range" id="input-unified-shadow-offset-y" min="-100" max="100" defaultValue="4" className="slider-control" />
              </div>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Text Opacity</span>
                <span className="group-value-badge" id="val-text-opacity">100%</span>
              </div>
              <input type="range" id="input-text-opacity" min="0" max="100" defaultValue="100" className="slider-control" />
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Background Opacity</span>
                <span className="group-value-badge" id="val-background-opacity">100%</span>
              </div>
              <input type="range" id="input-background-opacity" min="0" max="100" defaultValue="100" className="slider-control" />
              <p className="field-hint">Only visible when a Box color is active.</p>
            </div>
          </div>
        </div>

        {/* 3. Animation Modes Section */}
        <div className="accordion-item">
          <button type="button" className="accordion-header">
            <span className="accordion-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
              Animation Mode
            </span>
            <svg className="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <div className="accordion-body">
            <div className="settings-group">
              <div className="radio-toggle-grid animation-mode-grid">
                <label className="radio-tab">
                  <input type="radio" name="anim-mode" value="karaoke" defaultChecked />
                  <span>Karaoke</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="anim-mode" value="pop" />
                  <span>Pop</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="anim-mode" value="instant" />
                  <span>Instant</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="anim-mode" value="typewriter" />
                  <span>Typewriter</span>
                </label>
              </div>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Pop Scaling</span>
                <span className="group-value-badge" id="val-pop-scale">118%</span>
              </div>
              <input type="range" id="input-pop-scale" min="100" max="300" defaultValue="118" className="slider-control" />
            </div>
          </div>
        </div>

        {/* 4. Position & Offset Section */}
        <div className="accordion-item">
          <button type="button" className="accordion-header">
            <span className="accordion-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              Position & Spacing
            </span>
            <svg className="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <div className="accordion-body">
            <div className="settings-group">
              <label className="group-label">Vertical Alignment</label>
              <div className="radio-toggle-grid">
                <label className="radio-tab">
                  <input type="radio" name="sub-pos" value="top" />
                  <span>Top</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="sub-pos" value="center" />
                  <span>Center</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="sub-pos" value="bottom" defaultChecked />
                  <span>Bottom</span>
                </label>
                <label className="radio-tab">
                  <input type="radio" name="sub-pos" value="manual" />
                  <span>Manual</span>
                </label>
              </div>
              <p className="field-hint" id="manual-pos-hint" hidden>Drag the caption directly in the preview to reposition it.</p>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Vertical Offset</span>
                <span className="group-value-badge" id="val-margin-v">300px</span>
              </div>
              <input type="range" id="input-margin-v" min="0" max="1900" defaultValue="300" className="slider-control" />
            </div>
          </div>
        </div>

        {/* 5. AI Keyword Highlighting Section */}
        <div className="accordion-item">
          <button type="button" className="accordion-header">
            <span className="accordion-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
              AI Keywords
            </span>
            <svg className="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <div className="accordion-body">
            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Highlight Important Words</span>
                <label className="theme-toggle-label" title="Toggle AI keyword highlighting">
                  <input type="checkbox" id="toggle-keyword-highlighting" defaultChecked />
                  <span className="theme-slider" />
                </label>
              </div>
            </div>

            <div className="settings-group">
              <label className="group-label">Keyword Color</label>
              <div className="color-picker-grid">
                <div className="color-picker-item">
                  <label id="label-color-keyword">Color</label>
                  <button type="button" className="color-swatch-trigger" id="color-keyword" data-color-key="keywordColor" aria-haspopup="true" aria-labelledby="label-color-keyword" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 6. Keyword Style Section (keyword-driven presets, e.g. WAYLES) */}
        <div className="accordion-item">
          <button type="button" className="accordion-header">
            <span className="accordion-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
              Keyword Style
            </span>
            <svg className="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <div className="accordion-body">
            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Active Word Highlight</span>
                <label className="theme-toggle-label" title="Toggle the base active/inactive word highlight">
                  <input type="checkbox" id="toggle-active-highlight" defaultChecked />
                  <span className="theme-slider" />
                </label>
              </div>
              <p className="field-hint">Disabled by default on keyword-driven presets like WAYLES, where keyword styling is the primary emphasis system. Can be re-enabled manually.</p>
            </div>

            <div className="settings-group">
              <label htmlFor="select-keyword-font" className="group-label">Keyword Font</label>
              <select id="select-keyword-font" className="select-control" defaultValue="">
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

            <div className="settings-group">
              <label htmlFor="select-keyword-weight" className="group-label">Keyword Weight</label>
              <select id="select-keyword-weight" className="select-control" defaultValue="">
                <option value="">Preset Default</option>
                <option value="400">Regular (400)</option>
                <option value="600">Semi-Bold (600)</option>
                <option value="700">Bold (700)</option>
                <option value="800">Extra-Bold (800)</option>
                <option value="900">Black (900)</option>
              </select>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Keyword Scale</span>
                <span className="group-value-badge" id="val-keyword-scale">120%</span>
              </div>
              <input type="range" id="input-keyword-scale" min="100" max="300" defaultValue="120" className="slider-control" />
            </div>

            <div className="settings-group">
              <label htmlFor="select-keyword-animation" className="group-label">Keyword Animation</label>
              <select id="select-keyword-animation" className="select-control" defaultValue="pop">
                <option value="pop">Pop</option>
                <option value="none">None</option>
              </select>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Keyword Shadow</span>
                <label className="theme-toggle-label" title="Toggle a soft shadow on keyword words">
                  <input type="checkbox" id="toggle-keyword-shadow" />
                  <span className="theme-slider" />
                </label>
              </div>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Keyword Outline</span>
                <label className="theme-toggle-label" title="Toggle an outline on keyword words">
                  <input type="checkbox" id="toggle-keyword-outline" />
                  <span className="theme-slider" />
                </label>
              </div>
            </div>

            <div className="settings-group">
              <div className="label-justify">
                <span className="group-label">Keyword Opacity</span>
                <span className="group-value-badge" id="val-keyword-opacity">100%</span>
              </div>
              <input type="range" id="input-keyword-opacity" min="0" max="100" defaultValue="100" className="slider-control" />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

