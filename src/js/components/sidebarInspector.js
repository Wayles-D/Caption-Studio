/**
 * Left Sidebar Inspector UI Component for Caption Studio
 */
import { appState, updateState, subscribe, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig, CREATOR_PROFILES } from '../../../shared/captionConfig.js';
import { initColorPicker, syncColorSwatches } from './colorPicker.js';

const COLOR_FALLBACK_MAP = {
  activeWordColor: (cssConfig) => cssConfig.highlightColor || '#FEF08A',
  inactiveWordColor: (cssConfig) => cssConfig.inactiveColor || '#FFFFFF',
  outlineColor: (cssConfig) => cssConfig.outlineColor || '#000000',
  backgroundColor: (cssConfig) => (cssConfig.backgroundColor && cssConfig.backgroundColor !== 'transparent') ? cssConfig.backgroundColor : '#000000',
  shadowColor: () => getCurrentProfile().colors.shadowHex || '#000000',
  keywordColorHigh: (cssConfig) => cssConfig.keywordColorHigh || '#EF4444',
  keywordColorMedium: (cssConfig) => cssConfig.keywordColorMedium || '#FB923C'
};

function getFallbackColorFor(fieldKey) {
  const cssConfig = getCSSPreviewFromConfig(getStyleParams());
  const resolver = COLOR_FALLBACK_MAP[fieldKey];
  return resolver ? resolver(cssConfig) : '#000000';
}

function getCurrentProfile() {
  return CREATOR_PROFILES[appState.currentPreset] || CREATOR_PROFILES['bold-yellow'];
}

/**
 * Outline/shadow size sliders are null by default (meaning "use the active
 * preset's own value"), mirroring the color pickers' override-or-fallback
 * pattern — so the slider always shows a meaningful number even before the
 * user ever touches it, and switching presets updates the displayed default.
 */
function getFallbackOutlineSize() {
  return getCurrentProfile().outlineSize;
}

function getFallbackShadowSize() {
  return getCurrentProfile().shadowSize;
}

function getFallbackShadowOffset() {
  // Matches the shared engine's own default: a symmetric offset equal to the
  // current shadow size (ASS's native Shadow-field behavior with no override).
  return appState.shadowSize ?? getFallbackShadowSize();
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

  // 4b. Outline, Shadow & Opacity Controls
  const inputOutlineSize = document.getElementById('input-outline-size');
  const valOutlineSize = document.getElementById('val-outline-size');
  const inputShadowSize = document.getElementById('input-shadow-size');
  const valShadowSize = document.getElementById('val-shadow-size');
  const inputShadowOffsetX = document.getElementById('input-shadow-offset-x');
  const valShadowOffsetX = document.getElementById('val-shadow-offset-x');
  const inputShadowOffsetY = document.getElementById('input-shadow-offset-y');
  const valShadowOffsetY = document.getElementById('val-shadow-offset-y');
  const inputTextOpacity = document.getElementById('input-text-opacity');
  const valTextOpacity = document.getElementById('val-text-opacity');
  const inputBackgroundOpacity = document.getElementById('input-background-opacity');
  const valBackgroundOpacity = document.getElementById('val-background-opacity');

  if (inputOutlineSize) {
    inputOutlineSize.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valOutlineSize) valOutlineSize.textContent = `${val}px`;
      updateState({ outlineSize: val });
    });
  }

  if (inputShadowSize) {
    inputShadowSize.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valShadowSize) valShadowSize.textContent = `${val}px`;
      updateState({ shadowSize: val });
    });
  }

  if (inputShadowOffsetX) {
    inputShadowOffsetX.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valShadowOffsetX) valShadowOffsetX.textContent = `${val}px`;
      updateState({ shadowOffsetX: val });
    });
  }

  if (inputShadowOffsetY) {
    inputShadowOffsetY.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valShadowOffsetY) valShadowOffsetY.textContent = `${val}px`;
      updateState({ shadowOffsetY: val });
    });
  }

  if (inputTextOpacity) {
    inputTextOpacity.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valTextOpacity) valTextOpacity.textContent = `${val}%`;
      updateState({ textOpacity: val });
    });
  }

  if (inputBackgroundOpacity) {
    inputBackgroundOpacity.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valBackgroundOpacity) valBackgroundOpacity.textContent = `${val}%`;
      updateState({ backgroundOpacity: val });
    });
  }

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

  // Outline, Shadow & Opacity
  const inputOutlineSize = document.getElementById('input-outline-size');
  const valOutlineSize = document.getElementById('val-outline-size');
  const outlineSize = appState.outlineSize ?? getFallbackOutlineSize();
  if (inputOutlineSize) inputOutlineSize.value = outlineSize;
  if (valOutlineSize) valOutlineSize.textContent = `${outlineSize}px`;

  const inputShadowSize = document.getElementById('input-shadow-size');
  const valShadowSize = document.getElementById('val-shadow-size');
  const shadowSize = appState.shadowSize ?? getFallbackShadowSize();
  if (inputShadowSize) inputShadowSize.value = shadowSize;
  if (valShadowSize) valShadowSize.textContent = `${shadowSize}px`;

  const inputShadowOffsetX = document.getElementById('input-shadow-offset-x');
  const valShadowOffsetX = document.getElementById('val-shadow-offset-x');
  const shadowOffsetX = appState.shadowOffsetX ?? getFallbackShadowOffset();
  if (inputShadowOffsetX) inputShadowOffsetX.value = shadowOffsetX;
  if (valShadowOffsetX) valShadowOffsetX.textContent = `${shadowOffsetX}px`;

  const inputShadowOffsetY = document.getElementById('input-shadow-offset-y');
  const valShadowOffsetY = document.getElementById('val-shadow-offset-y');
  const shadowOffsetY = appState.shadowOffsetY ?? getFallbackShadowOffset();
  if (inputShadowOffsetY) inputShadowOffsetY.value = shadowOffsetY;
  if (valShadowOffsetY) valShadowOffsetY.textContent = `${shadowOffsetY}px`;

  const inputTextOpacity = document.getElementById('input-text-opacity');
  const valTextOpacity = document.getElementById('val-text-opacity');
  const textOpacity = appState.textOpacity ?? 100;
  if (inputTextOpacity) inputTextOpacity.value = textOpacity;
  if (valTextOpacity) valTextOpacity.textContent = `${textOpacity}%`;

  const inputBackgroundOpacity = document.getElementById('input-background-opacity');
  const valBackgroundOpacity = document.getElementById('val-background-opacity');
  const backgroundOpacity = appState.backgroundOpacity ?? 100;
  if (inputBackgroundOpacity) inputBackgroundOpacity.value = backgroundOpacity;
  if (valBackgroundOpacity) valBackgroundOpacity.textContent = `${backgroundOpacity}%`;

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
