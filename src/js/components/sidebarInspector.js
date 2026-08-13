/**
 * Left Sidebar Inspector UI Component for Caption Studio
 */
import { appState, updateState, subscribe, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig, CREATOR_PROFILES, resolveUnifiedShadowParams } from '../../../shared/captionConfig.js';
import { initColorPicker, syncColorSwatches } from './colorPicker.js';

const COLOR_FALLBACK_MAP = {
  activeWordColor: (cssConfig) => cssConfig.highlightColor || '#FEF08A',
  inactiveWordColor: (cssConfig) => cssConfig.inactiveColor || '#FFFFFF',
  outlineColor: (cssConfig) => cssConfig.outlineColor || '#000000',
  backgroundColor: (cssConfig) => (cssConfig.backgroundColor && cssConfig.backgroundColor !== 'transparent') ? cssConfig.backgroundColor : '#000000',
  shadowColor: () => getCurrentProfile().colors.shadowHex || '#000000',
  unifiedShadowColor: () => resolveUnifiedShadowParams({}).colorHex,
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

const DEFAULT_KEYWORD_TIER_FALLBACK = { fontFamily: '', fontWeight: '', fontScale: 1, animation: 'none', shadowByDefault: false, outlineByDefault: false };

function getFallbackKeywordTier(tier) {
  return getCurrentProfile().keywordStyle?.[tier] || DEFAULT_KEYWORD_TIER_FALLBACK;
}

function getFallbackActiveHighlightEnabled() {
  return !getCurrentProfile().disableActiveHighlightByDefault;
}

// Unified Shadow sliders are null by default too, meaning "use the built-in
// subtle-centered-shadow default" — same override-or-fallback pattern as the
// Individual shadow's own sliders above, just backed by a fixed default
// rather than a per-preset one (Unified Shadow isn't preset-specific).
function getFallbackUnifiedShadow() {
  return resolveUnifiedShadowParams({});
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
      const updates = { currentPreset: presetKey };
      // Font Family is otherwise a global override independent of preset; a
      // preset can opt into a one-time convenience default the moment it's
      // selected via autoFontFamilyOnSelect (still just a regular override
      // afterward — the user can change it like any other preset's font).
      const targetProfile = CREATOR_PROFILES[presetKey];
      if (targetProfile?.autoFontFamilyOnSelect) {
        updates.fontFamily = targetProfile.autoFontFamilyOnSelect;
      }
      updateState(updates);
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

  // 4c. Shadow Mode (None / Individual / Unified) & the Unified shadow's own controls
  const shadowModeRadios = document.getElementsByName('shadow-mode');
  const inputUnifiedShadowOpacity = document.getElementById('input-unified-shadow-opacity');
  const valUnifiedShadowOpacity = document.getElementById('val-unified-shadow-opacity');
  const inputUnifiedShadowBlur = document.getElementById('input-unified-shadow-blur');
  const valUnifiedShadowBlur = document.getElementById('val-unified-shadow-blur');
  const inputUnifiedShadowOffsetX = document.getElementById('input-unified-shadow-offset-x');
  const valUnifiedShadowOffsetX = document.getElementById('val-unified-shadow-offset-x');
  const inputUnifiedShadowOffsetY = document.getElementById('input-unified-shadow-offset-y');
  const valUnifiedShadowOffsetY = document.getElementById('val-unified-shadow-offset-y');

  shadowModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      updateState({ shadowMode: e.target.value });
    });
  });

  if (inputUnifiedShadowOpacity) {
    inputUnifiedShadowOpacity.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valUnifiedShadowOpacity) valUnifiedShadowOpacity.textContent = `${val}%`;
      updateState({ unifiedShadowOpacity: val });
    });
  }

  if (inputUnifiedShadowBlur) {
    inputUnifiedShadowBlur.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valUnifiedShadowBlur) valUnifiedShadowBlur.textContent = `${val}px`;
      updateState({ unifiedShadowBlur: val });
    });
  }

  if (inputUnifiedShadowOffsetX) {
    inputUnifiedShadowOffsetX.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valUnifiedShadowOffsetX) valUnifiedShadowOffsetX.textContent = `${val}px`;
      updateState({ unifiedShadowOffsetX: val });
    });
  }

  if (inputUnifiedShadowOffsetY) {
    inputUnifiedShadowOffsetY.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valUnifiedShadowOffsetY) valUnifiedShadowOffsetY.textContent = `${val}px`;
      updateState({ unifiedShadowOffsetY: val });
    });
  }

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

  // 8. Keyword Style Section (keyword-driven presets, e.g. WAYLES)
  const toggleActiveHighlight = document.getElementById('toggle-active-highlight');
  const selectKeywordPrimaryFont = document.getElementById('select-keyword-primary-font');
  const selectKeywordMediumFont = document.getElementById('select-keyword-medium-font');
  const selectKeywordPrimaryWeight = document.getElementById('select-keyword-primary-weight');
  const selectKeywordMediumWeight = document.getElementById('select-keyword-medium-weight');
  const inputKeywordPrimaryScale = document.getElementById('input-keyword-primary-scale');
  const valKeywordPrimaryScale = document.getElementById('val-keyword-primary-scale');
  const inputKeywordMediumScale = document.getElementById('input-keyword-medium-scale');
  const valKeywordMediumScale = document.getElementById('val-keyword-medium-scale');
  const selectKeywordPrimaryAnimation = document.getElementById('select-keyword-primary-animation');
  const toggleKeywordShadow = document.getElementById('toggle-keyword-shadow');
  const toggleKeywordOutline = document.getElementById('toggle-keyword-outline');
  const inputKeywordOpacity = document.getElementById('input-keyword-opacity');
  const valKeywordOpacity = document.getElementById('val-keyword-opacity');

  if (toggleActiveHighlight) {
    toggleActiveHighlight.addEventListener('change', (e) => {
      updateState({ enableActiveHighlight: e.target.checked });
    });
  }

  if (selectKeywordPrimaryFont) {
    selectKeywordPrimaryFont.addEventListener('change', (e) => {
      updateState({ keywordPrimaryFont: e.target.value || null });
    });
  }

  if (selectKeywordMediumFont) {
    selectKeywordMediumFont.addEventListener('change', (e) => {
      updateState({ keywordMediumFont: e.target.value || null });
    });
  }

  if (selectKeywordPrimaryWeight) {
    selectKeywordPrimaryWeight.addEventListener('change', (e) => {
      updateState({ keywordPrimaryWeight: e.target.value || null });
    });
  }

  if (selectKeywordMediumWeight) {
    selectKeywordMediumWeight.addEventListener('change', (e) => {
      updateState({ keywordMediumWeight: e.target.value || null });
    });
  }

  if (inputKeywordPrimaryScale) {
    inputKeywordPrimaryScale.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valKeywordPrimaryScale) valKeywordPrimaryScale.textContent = `${val}%`;
      updateState({ keywordPrimaryScale: val / 100 });
    });
  }

  if (inputKeywordMediumScale) {
    inputKeywordMediumScale.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valKeywordMediumScale) valKeywordMediumScale.textContent = `${val}%`;
      updateState({ keywordMediumScale: val / 100 });
    });
  }

  if (selectKeywordPrimaryAnimation) {
    selectKeywordPrimaryAnimation.addEventListener('change', (e) => {
      updateState({ keywordPrimaryAnimation: e.target.value || null });
    });
  }

  if (toggleKeywordShadow) {
    toggleKeywordShadow.addEventListener('change', (e) => {
      updateState({ keywordShadowEnabled: e.target.checked });
    });
  }

  if (toggleKeywordOutline) {
    toggleKeywordOutline.addEventListener('change', (e) => {
      updateState({ keywordOutlineEnabled: e.target.checked });
    });
  }

  if (inputKeywordOpacity) {
    inputKeywordOpacity.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      if (valKeywordOpacity) valKeywordOpacity.textContent = `${val}%`;
      updateState({ keywordOpacity: val });
    });
  }

  // 9. Subscribe to global state changes to synchronize UI controls
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

  // Shadow Mode + Unified Shadow controls
  const shadowMode = appState.shadowMode || 'individual';
  const shadowModeRadios = document.getElementsByName('shadow-mode');
  shadowModeRadios.forEach(r => { r.checked = r.value === shadowMode; });

  const individualShadowControls = document.getElementById('individual-shadow-controls');
  if (individualShadowControls) individualShadowControls.hidden = shadowMode !== 'individual';
  // `.hidden` alone doesn't work here: .color-picker-item's own `display:
  // flex` in style.css overrides the [hidden] UA default (author styles always
  // beat UA styles), so the display value has to be set explicitly instead.
  const shadowColorItem = document.getElementById('shadow-color-item');
  if (shadowColorItem) shadowColorItem.style.display = shadowMode !== 'individual' ? 'none' : '';
  const unifiedShadowControls = document.getElementById('unified-shadow-controls');
  if (unifiedShadowControls) unifiedShadowControls.hidden = shadowMode !== 'unified';

  const fallbackUnified = getFallbackUnifiedShadow();

  const inputUnifiedShadowOpacity = document.getElementById('input-unified-shadow-opacity');
  const valUnifiedShadowOpacity = document.getElementById('val-unified-shadow-opacity');
  const unifiedShadowOpacity = appState.unifiedShadowOpacity ?? fallbackUnified.opacity;
  if (inputUnifiedShadowOpacity) inputUnifiedShadowOpacity.value = unifiedShadowOpacity;
  if (valUnifiedShadowOpacity) valUnifiedShadowOpacity.textContent = `${unifiedShadowOpacity}%`;

  const inputUnifiedShadowBlur = document.getElementById('input-unified-shadow-blur');
  const valUnifiedShadowBlur = document.getElementById('val-unified-shadow-blur');
  const unifiedShadowBlur = appState.unifiedShadowBlur ?? fallbackUnified.blurAss;
  if (inputUnifiedShadowBlur) inputUnifiedShadowBlur.value = unifiedShadowBlur;
  if (valUnifiedShadowBlur) valUnifiedShadowBlur.textContent = `${unifiedShadowBlur}px`;

  const inputUnifiedShadowOffsetX = document.getElementById('input-unified-shadow-offset-x');
  const valUnifiedShadowOffsetX = document.getElementById('val-unified-shadow-offset-x');
  const unifiedShadowOffsetX = appState.unifiedShadowOffsetX ?? fallbackUnified.offsetXAss;
  if (inputUnifiedShadowOffsetX) inputUnifiedShadowOffsetX.value = unifiedShadowOffsetX;
  if (valUnifiedShadowOffsetX) valUnifiedShadowOffsetX.textContent = `${unifiedShadowOffsetX}px`;

  const inputUnifiedShadowOffsetY = document.getElementById('input-unified-shadow-offset-y');
  const valUnifiedShadowOffsetY = document.getElementById('val-unified-shadow-offset-y');
  const unifiedShadowOffsetY = appState.unifiedShadowOffsetY ?? fallbackUnified.offsetYAss;
  if (inputUnifiedShadowOffsetY) inputUnifiedShadowOffsetY.value = unifiedShadowOffsetY;
  if (valUnifiedShadowOffsetY) valUnifiedShadowOffsetY.textContent = `${unifiedShadowOffsetY}px`;

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

  // Keyword Style Section (keyword-driven presets, e.g. WAYLES)
  const toggleActiveHighlight = document.getElementById('toggle-active-highlight');
  if (toggleActiveHighlight) {
    toggleActiveHighlight.checked = appState.enableActiveHighlight ?? getFallbackActiveHighlightEnabled();
  }

  const selectKeywordPrimaryFont = document.getElementById('select-keyword-primary-font');
  if (selectKeywordPrimaryFont) selectKeywordPrimaryFont.value = appState.keywordPrimaryFont || '';

  const selectKeywordMediumFont = document.getElementById('select-keyword-medium-font');
  if (selectKeywordMediumFont) selectKeywordMediumFont.value = appState.keywordMediumFont || '';

  const selectKeywordPrimaryWeight = document.getElementById('select-keyword-primary-weight');
  if (selectKeywordPrimaryWeight) selectKeywordPrimaryWeight.value = appState.keywordPrimaryWeight || '';

  const selectKeywordMediumWeight = document.getElementById('select-keyword-medium-weight');
  if (selectKeywordMediumWeight) selectKeywordMediumWeight.value = appState.keywordMediumWeight || '';

  const inputKeywordPrimaryScale = document.getElementById('input-keyword-primary-scale');
  const valKeywordPrimaryScale = document.getElementById('val-keyword-primary-scale');
  const keywordPrimaryScalePct = Math.round((appState.keywordPrimaryScale ?? getFallbackKeywordTier('high').fontScale) * 100);
  if (inputKeywordPrimaryScale) inputKeywordPrimaryScale.value = keywordPrimaryScalePct;
  if (valKeywordPrimaryScale) valKeywordPrimaryScale.textContent = `${keywordPrimaryScalePct}%`;

  const inputKeywordMediumScale = document.getElementById('input-keyword-medium-scale');
  const valKeywordMediumScale = document.getElementById('val-keyword-medium-scale');
  const keywordMediumScalePct = Math.round((appState.keywordMediumScale ?? getFallbackKeywordTier('medium').fontScale) * 100);
  if (inputKeywordMediumScale) inputKeywordMediumScale.value = keywordMediumScalePct;
  if (valKeywordMediumScale) valKeywordMediumScale.textContent = `${keywordMediumScalePct}%`;

  const selectKeywordPrimaryAnimation = document.getElementById('select-keyword-primary-animation');
  if (selectKeywordPrimaryAnimation) {
    selectKeywordPrimaryAnimation.value = appState.keywordPrimaryAnimation || getFallbackKeywordTier('high').animation || 'none';
  }

  const toggleKeywordShadow = document.getElementById('toggle-keyword-shadow');
  if (toggleKeywordShadow) {
    toggleKeywordShadow.checked = appState.keywordShadowEnabled ?? getFallbackKeywordTier('high').shadowByDefault;
  }

  const toggleKeywordOutline = document.getElementById('toggle-keyword-outline');
  if (toggleKeywordOutline) {
    toggleKeywordOutline.checked = appState.keywordOutlineEnabled ?? getFallbackKeywordTier('high').outlineByDefault;
  }

  const inputKeywordOpacity = document.getElementById('input-keyword-opacity');
  const valKeywordOpacity = document.getElementById('val-keyword-opacity');
  const keywordOpacity = appState.keywordOpacity ?? 100;
  if (inputKeywordOpacity) inputKeywordOpacity.value = keywordOpacity;
  if (valKeywordOpacity) valKeywordOpacity.textContent = `${keywordOpacity}%`;
}
