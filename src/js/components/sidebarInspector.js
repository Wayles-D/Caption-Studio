/**
 * Left Sidebar Inspector UI Component for Caption Studio
 */
import { appState, updateState, subscribe, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig } from '../../../shared/captionConfig.js';
import { initColorPicker, syncColorSwatches } from './colorPicker.js';

const COLOR_FALLBACK_MAP = {
  activeWordColor: (cssConfig) => cssConfig.highlightColor || '#FEF08A',
  inactiveWordColor: (cssConfig) => cssConfig.inactiveColor || '#FFFFFF',
  outlineColor: (cssConfig) => cssConfig.outlineColor || '#000000',
  backgroundColor: (cssConfig) => (cssConfig.backgroundColor && cssConfig.backgroundColor !== 'transparent') ? cssConfig.backgroundColor : '#000000',
  keywordColorHigh: (cssConfig) => cssConfig.keywordColorHigh || '#EF4444',
  keywordColorMedium: (cssConfig) => cssConfig.keywordColorMedium || '#FB923C'
};

function getFallbackColorFor(fieldKey) {
  const cssConfig = getCSSPreviewFromConfig(getStyleParams());
  const resolver = COLOR_FALLBACK_MAP[fieldKey];
  return resolver ? resolver(cssConfig) : '#000000';
}

export function initSidebarInspector() {
  // 1. Accordion Header Toggle Binding
  const accordionHeaders = document.querySelectorAll('.accordion-header');
  accordionHeaders.forEach(header => {
    header.addEventListener('click', () => {
      const item = header.closest('.accordion-item');
      item.classList.toggle('collapsed');
    });
  });

  // 2. Preset Selection Buttons
  const presetBtns = document.querySelectorAll('.preset-btn');
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const presetKey = btn.dataset.preset;
      // Presets define style only (typography, border, shadow, padding) — never colors.
      // Custom color overrides must survive a preset switch.
      updateState({ currentPreset: presetKey });
    });
  });

  // 3. Typography Inputs
  const fontFamilySelect = document.getElementById('font-family-select');
  const inputFontSize = document.getElementById('input-font-size');
  const valFontSize = document.getElementById('val-font-size');
  const inputWordSpacing = document.getElementById('input-word-spacing');
  const valWordSpacing = document.getElementById('val-word-spacing');
  const textCaseRadios = document.getElementsByName('text-case');

  if (fontFamilySelect) {
    fontFamilySelect.addEventListener('change', (e) => {
      updateState({ fontFamily: e.target.value });
    });
  }

  if (inputFontSize) {
    inputFontSize.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valFontSize) valFontSize.textContent = `${val}px`;
      updateState({ fontSize: val });
    });
  }

  if (inputWordSpacing) {
    inputWordSpacing.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valWordSpacing) valWordSpacing.textContent = `${val}px`;
      updateState({ wordSpacing: val });
    });
  }

  textCaseRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      updateState({ textCase: e.target.value });
    });
  });

  // 4. Custom Color Picker Popovers (preset palette + hex + recently used)
  initColorPicker({ getFallbackColor: getFallbackColorFor });

  // 5. Animation Mode & Pop Scale Inputs
  const animModeRadios = document.getElementsByName('anim-mode');
  const inputPopScale = document.getElementById('input-pop-scale');
  const valPopScale = document.getElementById('val-pop-scale');

  animModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      updateState({ animationMode: e.target.value });
    });
  });

  if (inputPopScale) {
    inputPopScale.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valPopScale) valPopScale.textContent = `${val}%`;
      updateState({ popScale: val });
    });
  }

  // 6. Subtitle Position & Spacing Inputs
  const positionRadios = document.getElementsByName('sub-pos');
  const inputMarginV = document.getElementById('input-margin-v');
  const valMarginV = document.getElementById('val-margin-v');

  positionRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const newPosition = e.target.value;
      if (newPosition === 'manual') {
        updateState({ position: newPosition });
      } else {
        // Switching back to a preset resets the dragged custom position, so
        // re-entering Manual mode later always starts from the same default
        // spot rather than a stale dragged one.
        updateState({ position: newPosition, customPosX: 50, customPosY: 85 });
      }
    });
  });

  if (inputMarginV) {
    inputMarginV.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valMarginV) valMarginV.textContent = `${val}px`;
      updateState({ marginV: val });
    });
  }

  // 7. AI Keyword Highlighting Toggle
  const toggleKeywordHighlighting = document.getElementById('toggle-keyword-highlighting');
  if (toggleKeywordHighlighting) {
    toggleKeywordHighlighting.addEventListener('change', (e) => {
      updateState({ enableKeywordHighlighting: e.target.checked });
    });
  }

  // 8. Subscribe to global state changes to synchronize UI controls
  subscribe('*', () => {
    syncSidebarUI();
  });

  syncSidebarUI();
}

/**
 * Synchronize input controls with global appState values
 */
function syncSidebarUI() {
  // Preset Buttons
  const presetBtns = document.querySelectorAll('.preset-btn');
  presetBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === appState.currentPreset);
  });

  // Font Family
  const fontFamilySelect = document.getElementById('font-family-select');
  if (fontFamilySelect && fontFamilySelect.value !== appState.fontFamily) {
    fontFamilySelect.value = appState.fontFamily;
  }

  // Font Size
  const inputFontSize = document.getElementById('input-font-size');
  const valFontSize = document.getElementById('val-font-size');
  if (inputFontSize) inputFontSize.value = appState.fontSize;
  if (valFontSize) valFontSize.textContent = `${appState.fontSize}px`;

  // Word Spacing
  const inputWordSpacing = document.getElementById('input-word-spacing');
  const valWordSpacing = document.getElementById('val-word-spacing');
  if (inputWordSpacing) inputWordSpacing.value = appState.wordSpacing;
  if (valWordSpacing) valWordSpacing.textContent = `${appState.wordSpacing}px`;

  // Colors
  syncColorSwatches(getFallbackColorFor);

  // Animation Mode
  const animModeRadios = document.getElementsByName('anim-mode');
  animModeRadios.forEach(r => {
    r.checked = r.value === appState.animationMode;
  });

  // Pop Scale
  const inputPopScale = document.getElementById('input-pop-scale');
  const valPopScale = document.getElementById('val-pop-scale');
  if (inputPopScale) inputPopScale.value = appState.popScale;
  if (valPopScale) valPopScale.textContent = `${appState.popScale}%`;

  // Position & Margin
  const positionRadios = document.getElementsByName('sub-pos');
  positionRadios.forEach(r => {
    r.checked = r.value === appState.position;
  });

  const manualPosHint = document.getElementById('manual-pos-hint');
  if (manualPosHint) manualPosHint.hidden = appState.position !== 'manual';

  const inputMarginV = document.getElementById('input-margin-v');
  const valMarginV = document.getElementById('val-margin-v');
  if (inputMarginV) inputMarginV.value = appState.marginV || 300;
  if (valMarginV) valMarginV.textContent = `${appState.marginV || 300}px`;

  // AI Keyword Highlighting Toggle
  const toggleKeywordHighlighting = document.getElementById('toggle-keyword-highlighting');
  if (toggleKeywordHighlighting) toggleKeywordHighlighting.checked = !!appState.enableKeywordHighlighting;
}
