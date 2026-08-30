/**
 * Resolves the preset-default color/profile a field should display when the
 * user hasn't picked a custom override yet — extracted out of
 * sidebarInspector.js (which still uses getCurrentProfile for its own
 * non-color fallbacks: outline/shadow size, keyword tier, etc.) so
 * ColorPickerField.jsx (via SidebarInspector.jsx) can resolve the exact same
 * fallback a swatch always has, without duplicating this logic.
 */
import { appState, getStyleParams } from '../state.js';
import { getCSSPreviewFromConfig, CREATOR_PROFILES, resolveUnifiedShadowParams } from '../../../shared/captionConfig.js';

export function getCurrentProfile() {
  return CREATOR_PROFILES[appState.currentPreset] || CREATOR_PROFILES['bold-yellow'];
}

const COLOR_FALLBACK_MAP = {
  activeWordColor: (cssConfig) => cssConfig.highlightColor || '#FEF08A',
  inactiveWordColor: (cssConfig) => cssConfig.inactiveColor || '#FFFFFF',
  outlineColor: (cssConfig) => cssConfig.outlineColor || '#000000',
  backgroundColor: (cssConfig) => (cssConfig.backgroundColor && cssConfig.backgroundColor !== 'transparent') ? cssConfig.backgroundColor : '#000000',
  shadowColor: () => getCurrentProfile().colors.shadowHex || '#000000',
  unifiedShadowColor: () => resolveUnifiedShadowParams({}).colorHex,
  keywordColor: (cssConfig) => cssConfig.keywordColor || '#EF4444'
};

export function getFallbackColorFor(fieldKey) {
  const cssConfig = getCSSPreviewFromConfig(getStyleParams());
  const resolver = COLOR_FALLBACK_MAP[fieldKey];
  return resolver ? resolver(cssConfig) : '#000000';
}
