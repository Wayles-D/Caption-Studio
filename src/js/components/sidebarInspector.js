/**
 * Left Sidebar Inspector UI Component for Caption Studio
 */
import { appState, updateState, subscribe } from '../state.js';
import { getCSSPreviewFromConfig } from '../../../shared/captionConfig.js';

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
      updateState({
        currentPreset: presetKey,
        // Reset color overrides so preset defaults take effect
        activeWordColor: null,
        inactiveWordColor: null,
        outlineColor: null,
        backgroundColor: null
      });
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

  // 4. Color Customization Pickers
  const colorActive = document.getElementById('color-active-word');
  const colorInactive = document.getElementById('color-inactive-word');
  const colorOutline = document.getElementById('color-outline');
  const colorBackground = document.getElementById('color-background');

  if (colorActive) {
    colorActive.addEventListener('input', (e) => {
      updateState({ activeWordColor: e.target.value });
    });
  }

  if (colorInactive) {
    colorInactive.addEventListener('input', (e) => {
      updateState({ inactiveWordColor: e.target.value });
    });
  }

  if (colorOutline) {
    colorOutline.addEventListener('input', (e) => {
      updateState({ outlineColor: e.target.value });
    });
  }

  if (colorBackground) {
    colorBackground.addEventListener('input', (e) => {
      updateState({ backgroundColor: e.target.value });
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
      updateState({ position: e.target.value });
    });
  });

  if (inputMarginV) {
    inputMarginV.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valMarginV) valMarginV.textContent = `${val}px`;
      updateState({ marginV: val });
    });
  }

  // 7. Subscribe to global state changes to synchronize UI controls
  subscribe('*', () => {
    syncSidebarUI();
  });

  syncSidebarUI();
}

/**
 * Synchronize input controls with global appState values
 */
function syncSidebarUI() {
  const cssConfig = getCSSPreviewFromConfig({
    preset: appState.currentPreset,
    fontFamily: appState.fontFamily,
    fontSize: appState.fontSize,
    wordSpacing: appState.wordSpacing,
    popScale: appState.popScale,
    activeWordColor: appState.activeWordColor,
    inactiveWordColor: appState.inactiveWordColor,
    outlineColor: appState.outlineColor,
    backgroundColor: appState.backgroundColor,
    textCase: appState.textCase,
    position: appState.position,
    animationMode: appState.animationMode
  });

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
  const colorActive = document.getElementById('color-active-word');
  const colorInactive = document.getElementById('color-inactive-word');
  const colorOutline = document.getElementById('color-outline');
  const colorBackground = document.getElementById('color-background');

  if (colorActive) colorActive.value = cssConfig.highlightColor || '#FEF08A';
  if (colorInactive) colorInactive.value = cssConfig.inactiveColor || '#FFFFFF';
  if (colorOutline) colorOutline.value = cssConfig.outlineColor || '#000000';
  if (colorBackground) colorBackground.value = (cssConfig.backgroundColor && cssConfig.backgroundColor !== 'transparent') ? cssConfig.backgroundColor : '#000000';

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

  const inputMarginV = document.getElementById('input-margin-v');
  const valMarginV = document.getElementById('val-margin-v');
  if (inputMarginV) inputMarginV.value = appState.marginV || 300;
  if (valMarginV) valMarginV.textContent = `${appState.marginV || 300}px`;
}
